import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CashfreePaymentsService from "../cashfree/cashfree.payments.service.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { advisoryLock, asRecord, toTenDigitMobile, type Db } from "../integrations/integrations.common.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { isCodOrder, mapOrder } from "../shopify/shopify.mapper.js";
import { fetchOrder, type NormalizedOrder } from "../shopify/shopify.orders.js";
import { upsertOrder } from "../shopify/shopify.persist.js";
import { gidToId, toGid } from "../shopify/shopify.money.js";
import { ShopifyApiError } from "../shopify/shopify.client.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import DiscountsService from "../discounts/discounts.service.js";
import { loadDefaultDiscount } from "../discounts/discounts.config.js";
import { computeUpgradeAmounts, type UpgradeDiscountType } from "./orders.prepaid-upgrade.calc.js";
import { readHistory, readOffer, type PrepaidUpgradeOffer } from "./orders.prepaid-upgrade.hooks.js";
import { derivePaymentMode, scopedOrderWhere } from "./orders.filters.js";

// Telecaller "Prepaid Upgrade": offer a COD customer a discount to pay online instead. Domain/state flow only - the
// payment itself is the EXISTING Cashfree payment-link infrastructure (CashfreePaymentsService), and the COD -> prepaid
// conversion happens exclusively in onPrepaidUpgradePayment, driven by a verified Cashfree SUCCESS. Nothing here changes
// the order's payment mode or amount; creating an offer or a link never touches the COD order.
type CashfreeOps = Pick<CashfreePaymentsService, "createPaymentLink" | "cancelPaymentLink">;

const BLOCKED = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);
const ORDER_SELECT = {
  id: true,
  leadId: true,
  status: true,
  currency: true,
  orderNumber: true,
  source: true,
  externalSource: true,
  externalId: true,
  externalNumber: true,
  totalAmount: true,
  metadata: true,
  payments: { select: { id: true, method: true, status: true } },
} satisfies Prisma.OrderSelect;

export interface UpgradeView {
  /** The CRM order id once one exists (every CRM-backed order; a Shopify order after its first offer). null = a Shopify order not in the CRM yet. */
  orderId: string | null;
  eligible: boolean;
  /** The order is Cash on Delivery by the CRM's own rule (derivePaymentMode / metadata.paymentMode), whether or not it can be upgraded now. */
  isCod: boolean;
  /** Shopify side of a converted upgrade (distinct from "payment received"): COMPLETED, PENDING (not run yet) or FAILED (an admin must retry). NOT_APPLICABLE otherwise / for non-Shopify orders. No technical detail is exposed here. */
  shopifyReconciliation: "COMPLETED" | "PENDING" | "FAILED" | "NOT_APPLICABLE";
  /** Why it is not eligible (null when eligible or when an offer already exists). */
  reason: string | null;
  orderAmount: string;
  currency: string;
  offer: PrepaidUpgradeOffer | null;
  history: PrepaidUpgradeOffer[];
}

export interface UpgradeActionResult extends UpgradeView {
  /** true when an existing PAYMENT_PENDING offer/link was returned instead of creating another. */
  reused: boolean;
  /** The Payment to hand to the existing "send payment link on WhatsApp" action. */
  paymentId: string | null;
}

class PrepaidUpgradeService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getCashfree: () => CashfreeOps = () => new CashfreePaymentsService(),
    private readonly now: () => Date = () => new Date(),
    private readonly getShopifyClient: () => ShopifyClient = () => new ShopifyClient(loadShopifyConfig()),
  ) {}

  private async loadOrder(tx: Db, user: AuthUser, orderId: string) {
    const scope = await getLeadScope(user, tx as never);
    const order = await tx.order.findFirst({ where: scopedOrderWhere(orderId, scope), select: ORDER_SELECT });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    return order;
  }

  /** COD by the project's canonical rule: a COD payment row (what Shopify-synced and CRM-created orders both carry), or the order's own paymentMode. */
  private isCod(order: Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>): boolean {
    return derivePaymentMode(order.payments) === "COD" || asRecord(order.metadata).paymentMode === "COD";
  }

  private ineligibleReason(order: Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>, offer: PrepaidUpgradeOffer | null): string | null {
    if (offer?.status === "UPGRADED" || asRecord(order.metadata).paymentMode === "PREPAID") return "This order is already prepaid.";
    if (BLOCKED.has(order.status)) return `A ${order.status.toLowerCase()} order can not be upgraded.`;
    if (order.payments.some((p) => p.status === PaymentStatus.SUCCESS)) return "This order already has a successful payment.";
    if (!this.isCod(order)) return "Only Cash on Delivery orders can be upgraded to prepaid.";
    return null;
  }

  private view(order: Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>, extra: { reused?: boolean; paymentId?: string | null } = {}): UpgradeActionResult {
    const offer = readOffer(order.metadata);
    const reason = this.ineligibleReason(order, offer);
    const sync = asRecord(asRecord(order.metadata).shopifyPaymentSync).status;
    const shopifyReconciliation = offer?.status === "UPGRADED" && order.externalSource === "SHOPIFY" ? (sync === "synced" ? "COMPLETED" : sync === "failed" ? "FAILED" : "PENDING") : "NOT_APPLICABLE";
    return { orderId: order.id, shopifyReconciliation, eligible: reason === null, isCod: this.isCod(order) && offer?.status !== "UPGRADED", reason, orderAmount: order.totalAmount.toString(), currency: order.currency, offer, history: readHistory(order.metadata), reused: extra.reused ?? false, paymentId: extra.paymentId ?? offer?.paymentId ?? null };
  }

  async getUpgrade(user: AuthUser, orderId: string): Promise<UpgradeView> {
    const order = await this.loadOrder(this.db as unknown as Db, user, orderId);
    const { reused: _r, paymentId: _p, ...view } = this.view(order);
    return view;
  }

  private async save(tx: Db, order: Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>, offer: PrepaidUpgradeOffer | null, history: PrepaidUpgradeOffer[], activity: { user: AuthUser; title: string; description?: string }) {
    const meta = { ...asRecord(order.metadata), prepaidUpgrade: offer, prepaidUpgradeHistory: history };
    await tx.order.update({ where: { id: order.id }, data: { metadata: meta as unknown as Prisma.InputJsonValue } });
    await tx.activity.create({
      data: { leadId: order.leadId, orderId: order.id, actorId: activity.user.id, actorRole: activity.user.role, type: ActivityType.ORDER_STATUS_CHANGED, referenceType: "Order", referenceId: order.id, source: ActivitySource.USER, title: activity.title, description: activity.description ?? null, newValue: offer ? { prepaidUpgrade: { id: offer.id, status: offer.status, discountAmount: offer.discountAmount, prepaidAmount: offer.prepaidAmount } } : undefined },
    });
  }

  /** Creates (or replaces an un-sent) offer. The amounts are computed here from the order's real total - the browser sends only type + value. */
  async createOffer(user: AuthUser, orderId: string, input: { discountType?: UpgradeDiscountType; discountValue?: string; couponCode?: string; expectedPrepaidAmount?: string }): Promise<UpgradeActionResult> {
    return this.db.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(orderId));
      const order = await this.loadOrder(tx, user, orderId);
      const current = readOffer(order.metadata);
      const reason = this.ineligibleReason(order, current);
      if (reason) throw new ApiError(reason, STATUS_CODES.BAD_REQUEST);

      // One live offer per order: a link is already out for it -> show/reuse that, never a second competing one.
      if (current?.status === "PAYMENT_PENDING") return this.view(order, { reused: true });
      if (current?.status === "PAYMENT_RECEIVED") throw new ApiError("Payment for the previous offer was received and needs review before a new offer is made.", STATUS_CODES.CONFLICT);

      // A Fastrr coupon is resolved against the live active offers (its own type/value win; a request that also carries numbers is rejected), then the
      // normal Prepaid Upgrade rules apply to it exactly as to a typed discount. The chosen discount REPLACES the default - it never stacks.
      const originalCents = toCents(order.totalAmount.toString());
      let type = input.discountType;
      let value = input.discountValue;
      let chosen: { couponId: string | null; couponCode: string | null; source: "FASTRR" | "CUSTOM"; wasDefault: boolean } = { couponId: null, couponCode: null, source: "CUSTOM", wasDefault: false };
      if (input.couponCode) {
        const r = await new DiscountsService(this.db).resolve("UPGRADE", { couponCode: input.couponCode, type, value }, originalCents);
        type = r.type!;
        value = r.value!;
        chosen = { couponId: r.couponId, couponCode: r.couponCode, source: "FASTRR", wasDefault: r.wasDefault };
      }
      if (!type || value === undefined) throw new ApiError("Choose a coupon or enter a discount", STATUS_CODES.BAD_REQUEST);
      const amounts = computeUpgradeAmounts(originalCents, type, value);
      if (!input.couponCode) {
        const def = loadDefaultDiscount();
        chosen.wasDefault = def.type === type && Number(def.value) === Number(amounts.discountValue);
      }
      if (input.expectedPrepaidAmount !== undefined && toCents(input.expectedPrepaidAmount) !== amounts.prepaidCents) {
        throw new ApiError("The amount to collect changed. Please review the offer again.", STATUS_CODES.CONFLICT);
      }
      const nowIso = this.now().toISOString();
      const offer: PrepaidUpgradeOffer = {
        id: randomUUID(),
        status: "OFFERED",
        currency: order.currency,
        originalAmount: order.totalAmount.toString(),
        discountType: type,
        discountValue: amounts.discountValue,
        discountAmount: fromCents(amounts.discountCents),
        prepaidAmount: fromCents(amounts.prepaidCents),
        createdById: user.id,
        createdByName: (user as { name?: string }).name ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
        paymentId: null,
        paymentUrl: null,
        paidAt: null,
        upgradedAt: null,
        lastPaymentFailure: null,
        note: null,
        couponId: chosen.couponId,
        couponSource: chosen.source === "FASTRR" ? "FASTRR" : null,
        couponCode: chosen.couponCode,
        discountSource: chosen.source,
        wasDefault: chosen.wasDefault,
        orderSource: order.source,
        shopifyOrderId: order.externalSource === "SHOPIFY" ? order.externalId : null,
        shopifyOrderNumber: order.externalSource === "SHOPIFY" ? order.externalNumber : null,
      };
      const history = current ? [...readHistory(order.metadata), current] : readHistory(order.metadata);
      await this.save(tx, order, offer, history, { user, title: "Prepaid upgrade offered", description: `${chosen.couponCode ? `${chosen.couponCode}: ` : ""}${type === "FIXED" ? "₹" : ""}${amounts.discountValue}${type === "PERCENT" ? "%" : ""} off: customer pays ${offer.prepaidAmount} instead of COD ${offer.originalAmount}` });
      return this.view({ ...order, metadata: { ...asRecord(order.metadata), prepaidUpgrade: offer, prepaidUpgradeHistory: history } as unknown as Prisma.JsonValue });
    });
  }

  /** Generates (or reuses) the Cashfree payment link for the offer's server-computed prepaid amount, and marks it PAYMENT_PENDING. */
  async generateLink(user: AuthUser, orderId: string, upgradeId: string): Promise<UpgradeActionResult> {
    const prepared = await this.db.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(orderId));
      const order = await this.loadOrder(tx, user, orderId);
      const offer = readOffer(order.metadata);
      if (!offer || offer.id !== upgradeId) throw new ApiError("This offer is no longer current. Create a new one.", STATUS_CODES.CONFLICT);
      const reason = this.ineligibleReason(order, offer);
      if (reason) throw new ApiError(reason, STATUS_CODES.BAD_REQUEST);
      if (offer.status !== "OFFERED" && offer.status !== "PAYMENT_PENDING") throw new ApiError(`This offer is ${offer.status.toLowerCase().replace("_", " ")} and can not get a payment link.`, STATUS_CODES.CONFLICT);
      // The offer was priced against a specific COD total; if that moved, it must be re-made rather than silently re-priced.
      if (toCents(order.totalAmount.toString()) !== toCents(offer.originalAmount)) throw new ApiError("The order amount changed after this offer was made. Create a new offer.", STATUS_CODES.CONFLICT);
      return { order, offer };
    });

    // Existing infrastructure: creates the Cashfree link (or reuses an open one for the same amount). Never touches the order's mode/total.
    const link = await this.getCashfree().createPaymentLink(user, orderId, { amountCents: toCents(prepared.offer.prepaidAmount), upgradeId });

    return this.db.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(orderId));
      const order = await this.loadOrder(tx, user, orderId);
      const offer = readOffer(order.metadata);
      if (!offer || offer.id !== upgradeId) throw new ApiError("This offer is no longer current.", STATUS_CODES.CONFLICT);
      // A payment that completed while the link was being created already moved the offer on - never step it backwards.
      if (offer.status !== "OFFERED" && offer.status !== "PAYMENT_PENDING") return this.view(order, { paymentId: link.paymentId });
      const next: PrepaidUpgradeOffer = { ...offer, status: "PAYMENT_PENDING", paymentId: link.paymentId, paymentUrl: link.paymentUrl, updatedAt: this.now().toISOString(), lastPaymentFailure: null };
      await this.save(tx, order, next, readHistory(order.metadata), { user, title: link.reused ? "Prepaid upgrade payment link reused" : "Prepaid upgrade payment link generated", description: `Amount ${next.prepaidAmount}` });
      return this.view({ ...order, metadata: { ...asRecord(order.metadata), prepaidUpgrade: next } as unknown as Prisma.JsonValue }, { reused: link.reused, paymentId: link.paymentId });
    });
  }

  /** The customer said no. COD is untouched; an open payment link (if any) is cancelled first so it can no longer be paid. */
  async decline(user: AuthUser, orderId: string, upgradeId: string): Promise<UpgradeActionResult> {
    const before = await this.db.$transaction(async (tx) => {
      const order = await this.loadOrder(tx, user, orderId);
      const offer = readOffer(order.metadata);
      if (!offer || offer.id !== upgradeId) throw new ApiError("This offer is no longer current.", STATUS_CODES.CONFLICT);
      if (offer.status !== "OFFERED" && offer.status !== "PAYMENT_PENDING") throw new ApiError("This offer can no longer be declined.", STATUS_CODES.CONFLICT);
      return offer;
    });
    if (before.status === "PAYMENT_PENDING" && before.paymentId) {
      try {
        await this.getCashfree().cancelPaymentLink(user, before.paymentId);
      } catch (error) {
        throw new ApiError(`The payment link could not be cancelled, so the offer was kept: ${error instanceof Error ? error.message : "try again"}`, STATUS_CODES.CONFLICT);
      }
    }
    return this.db.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(orderId));
      const order = await this.loadOrder(tx, user, orderId);
      const offer = readOffer(order.metadata);
      if (!offer || offer.id !== upgradeId) throw new ApiError("This offer is no longer current.", STATUS_CODES.CONFLICT);
      if (offer.status === "UPGRADED" || offer.status === "PAYMENT_RECEIVED") return this.view(order); // paid in the meantime: not declinable
      const next: PrepaidUpgradeOffer = { ...offer, status: "DECLINED", paymentUrl: null, updatedAt: this.now().toISOString() };
      await this.save(tx, order, next, readHistory(order.metadata), { user, title: "Prepaid upgrade declined - order stays COD" });
      return this.view({ ...order, metadata: { ...asRecord(order.metadata), prepaidUpgrade: next } as unknown as Prisma.JsonValue });
    });
  }

  // ------------------------------------------------------------------ Shopify orders addressed by their Shopify id
  // Eligibility is a property of the ORDER (COD, not cancelled, not paid/refunded, payable amount, a phone to pay by) - not
  // of CRM sync. A Shopify order the CRM has never seen is evaluated straight from Shopify; the first offer on it brings
  // that one order into the CRM through the SAME mapper/persist code the Shopify webhooks use (no second order, no
  // customer-sync prerequisite for the user), because the payment link, payment record and audit trail live on a CRM order.

  private async findCrmOrderId(tx: Db, externalId: string): Promise<string | null> {
    const row = await tx.order.findFirst({ where: { externalSource: "SHOPIFY", externalId: { in: [gidToId(externalId), toGid("Order", gidToId(externalId))] } }, select: { id: true } });
    return row?.id ?? null;
  }

  private shopify(): ShopifyClient {
    try {
      return this.getShopifyClient();
    } catch (error) {
      throw new ApiError(error instanceof ShopifyConfigError ? error.message : "Shopify is not configured.", STATUS_CODES.SERVICE_UNAVAILABLE);
    }
  }

  private async fetchShopifyOrder(externalId: string): Promise<NormalizedOrder> {
    try {
      const raw = await fetchOrder(this.shopify(), toGid("Order", gidToId(externalId)));
      if (!raw) throw new ApiError("Shopify no longer has this order.", STATUS_CODES.NOT_FOUND);
      return raw;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again.", 502);
    }
  }

  /** Why a live Shopify order can not be upgraded (null = eligible). Same rules as the CRM path, from Shopify's own data. */
  private liveIneligibleReason(o: NormalizedOrder): string | null {
    const financial = (o.financialStatus ?? "").toUpperCase();
    if (o.cancelledAt) return "A cancelled order can not be upgraded.";
    if (["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"].includes(financial)) return `A ${financial.toLowerCase().replace("_", " ")} order can not be upgraded.`;
    if (financial === "PAID" || o.transactions.some((t) => t.status.toUpperCase() === "SUCCESS" && t.kind.toUpperCase() !== "REFUND" && !/\bcod\b|cash on delivery/i.test(t.gateway ?? ""))) return "This order already has a successful payment.";
    if (!isCodOrder(o)) return "Only Cash on Delivery orders can be upgraded to prepaid.";
    if (!(toCents(o.amounts.total) > 0)) return "This order has no payable amount.";
    if (!toTenDigitMobile(o.customer.phone ?? null)) return "The customer has no valid 10-digit mobile number, which the payment link needs.";
    return null;
  }

  async getLiveUpgrade(user: AuthUser, externalId: string): Promise<UpgradeView> {
    const crmId = await this.findCrmOrderId(this.db as unknown as Db, externalId);
    if (crmId) return this.getUpgrade(user, crmId);
    // Not in the CRM: there is no lead to scope by, so - like the rest of the unsynced-order pages - ADMIN only.
    if (user.role !== "ADMIN") throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    const o = await this.fetchShopifyOrder(externalId);
    const reason = this.liveIneligibleReason(o);
    const cod = isCodOrder(o);
    return { orderId: null, shopifyReconciliation: "NOT_APPLICABLE", eligible: reason === null, isCod: cod, reason, orderAmount: o.amounts.total ?? "0", currency: o.currency, offer: null, history: [] };
  }

  /** Creates the offer; on a Shopify order not yet in the CRM, first brings that single order in (no WhatsApp automations are run for it). */
  async createLiveOffer(user: AuthUser, externalId: string, input: { discountType?: UpgradeDiscountType; discountValue?: string; couponCode?: string; expectedPrepaidAmount?: string }): Promise<UpgradeActionResult> {
    let crmId = await this.findCrmOrderId(this.db as unknown as Db, externalId);
    if (!crmId) {
      if (user.role !== "ADMIN") throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
      const raw = await this.fetchShopifyOrder(externalId);
      const reason = this.liveIneligibleReason(raw);
      if (reason) throw new ApiError(reason, STATUS_CODES.BAD_REQUEST);
      // Validate the discount against Shopify's own total BEFORE creating anything in the CRM.
      const pre = input.couponCode ? await new DiscountsService(this.db).resolve("UPGRADE", { couponCode: input.couponCode, type: input.discountType, value: input.discountValue }, toCents(raw.amounts.total)) : null;
      const preType = pre?.type ?? input.discountType;
      const preValue = pre?.value ?? input.discountValue;
      if (!preType || preValue === undefined) throw new ApiError("Choose a coupon or enter a discount", STATUS_CODES.BAD_REQUEST);
      computeUpgradeAmounts(toCents(raw.amounts.total), preType, preValue);
      const mapped = mapOrder(raw);
      const result = await this.db.$transaction((tx) => upsertOrder(tx as never, mapped, { source: ActivitySource.USER }));
      if (!result.orderId) throw new ApiError("This Shopify order could not be brought into the CRM.", STATUS_CODES.SERVER_ERROR);
      crmId = result.orderId;
    }
    return this.createOffer(user, crmId, input);
  }

}

export default PrepaidUpgradeService;
