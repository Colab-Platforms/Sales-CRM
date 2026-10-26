import { prisma } from "@/lib/prisma.js";
import { getLeadScope, getManagerTeam, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { ShiprocketClient, type ShiprocketOrderLookup } from "../shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../shiprocket/shiprocket.config.js";
import { toCents } from "../shopify/shopify.money.js";
import { explainMoney } from "../shopify/shopify.order-audit.js";
import { stateToken } from "../shopify/shopify.order-sync.compare.js";
import { readSyncOrder, ShopifySyncReadError, type SyncShopifyOrder } from "../shopify/shopify.order-sync.read.js";
import { addShippingLineToOrder } from "../shopify/shopify.orders.edit.js";
import { canViewAllOrders, orderActionWhere } from "./orders.filters.js";
import { withOrderEditClaim } from "./orders.claim.js";

// REVIEW & CORRECT AMOUNT (order page). The CRM and the Shopify order disagree on what the customer owes. This compares every money field, explains the difference, and - for the ONE case it can safely repair - offers
// the correction: the CRM charges a shipping amount that the Shopify order has no shipping line for (the COD shipping rule is a flat 50.00). Everything else (a discount, a tax, a line item or price difference)
// is shown and routed to manual review.
//
// This IS a financial edit (it raises the amount owed), so it is gated hard, and every gate is checked on a fresh read of the CRM, Shopify AND Shiprocket right before the edit:
//   - Admin or Manager only to apply (a telecaller can only review);
//   - the order is open: not cancelled, Shopify UNFULFILLED, no CRM shipment, no refund, nothing paid or received, no payment transaction, a COD order;
//   - the COURIER amount agrees: a Shiprocket order imported for this Shopify order must be COD, still NEW (no AWB / courier), and its amount must ALREADY equal the corrected total. This tool never changes a
//     courier / COD amount, so a courier amount that would disagree with the corrected Shopify total blocks the edit (otherwise the customer would be charged one amount and the courier collect another);
//   - an explicit confirmation naming the new total, on a comparison token that is still current, under the per-order edit claim.
// It never marks anything paid, records no payment, refunds nothing, changes no fulfilment or shipment, and sends no message. The result is re-read from Shopify and verified; the actor, before / after and result go to
// the order's history.

const money = (c: number) => (c / 100).toFixed(2);
const NL = String.fromCharCode(10);
const firstLine = (e: unknown) => (e instanceof Error ? e.message.split(NL).join(" ").slice(0, 300) : "unknown error");
const EDIT_ROLES: Role[] = [Role.ADMIN, Role.MANAGER];
const EDITABLE_STATUSES: OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED, OrderStatus.PROCESSING];

const AMOUNT_SELECT = {
  id: true, orderNumber: true, status: true, source: true, currency: true, externalId: true, externalNumber: true, leadId: true,
  subtotal: true, discountAmount: true, shippingAmount: true, taxAmount: true, totalAmount: true, metadata: true,
  lead: { select: { id: true, firstName: true, lastName: true, email: true, normalizedMobile: true } },
  items: { select: { quantity: true, unitPrice: true, variant: { select: { externalId: true, externalSource: true } } } },
  shipments: { select: { id: true } },
  payments: { select: { status: true } },
  _count: { select: { refundRequests: true } },
} satisfies Prisma.OrderSelect;
type AmountOrder = Prisma.OrderGetPayload<{ select: typeof AMOUNT_SELECT }>;

export interface AmountRow { key: string; label: string; crm: string; shopify: string; status: "SAME" | "DIFFERENT" }
export interface AmountGate { key: string; label: string; ok: boolean; detail: string }
export interface AmountProposal {
  kind: "ADD_SHIPPING_LINE";
  title: string;
  amount: string;
  currency: string;
  before: { total: string; outstanding: string; shippingLines: number };
  after: { total: string; outstanding: string; shippingLines: number };
  reason: string;
  risk: string;
}
export interface AmountPreview {
  orderId: string;
  orderNumber: string;
  comparable: boolean;
  note: string | null;
  rows: AmountRow[];
  /** What the sync can correct (null = nothing it may fix automatically). */
  proposal: AmountProposal | null;
  /** Why there is no proposal although the amounts differ, or what a person must do. */
  manualReason: string | null;
  gates: AmountGate[];
  /** true when a proposal exists AND every gate passes AND the viewer may apply it. */
  canApply: boolean;
  /** The first thing blocking the correction, in plain words (null when it can be applied). */
  blockedReason: string | null;
  canExecute: boolean;
  stateToken: string | null;
  lastReviewedAt: string | null;
  courier: { found: boolean; status: string | null; paymentMethod: string | null; total: string | null; hasAwb: boolean; error: string | null } | null;
}
export interface AmountApplyResponse {
  outcome: "corrected" | "failed";
  message: string;
  before: { total: string; outstanding: string; shippingLines: number };
  after: { total: string; outstanding: string; shippingLines: number } | null;
  preview: AmountPreview;
}

export type CourierLookup = (shopifyOrderName: string) => Promise<ShiprocketOrderLookup[]>;
const defaultCourierLookup: CourierLookup = async (name) => {
  const config = loadShiprocketConfig(process.env);
  if (!config) throw new Error("Shiprocket is not configured");
  return new ShiprocketClient(config as never).findOrdersByChannelId(name);
};

export class OrderAmountService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => Pick<ShopifyClient, "query"> = () => new ShopifyClient(loadShopifyConfig()),
    private readonly courier: CourierLookup = defaultCourierLookup,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertRole(user: AuthUser): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER && user.role !== Role.SALESPERSON) throw new ApiError("You do not have permission to review order amounts", STATUS_CODES.FORBIDDEN);
  }

  /** "review" (the comparison) follows order-page visibility; "act" (the correction) keeps the strict action scope and answers an existing but out-of-scope order with a clear 403, never "Order not found". */
  private async load(user: AuthUser, orderId: string, mode: "review" | "act" = "act"): Promise<AmountOrder> {
    this.assertRole(user);
    const leadScope = await getLeadScope(user, this.db);
    const team = user.role === Role.MANAGER ? await getManagerTeam(user.id, this.db) : undefined;
    const where = mode === "review" && canViewAllOrders(user.role) ? { id: orderId } : orderActionWhere(user, orderId, leadScope, team?.members.map((m) => m.id) ?? []);
    const order = await this.db.order.findFirst({ where, select: AMOUNT_SELECT });
    if (order) return order;
    if (mode === "act" && canViewAllOrders(user.role) && (await this.db.order.findFirst({ where: { id: orderId }, select: { id: true } }))) {
      throw new ApiError("You can review this order, but you can only change orders you created or that belong to your team or lead scope. Ask the order's creator, their manager or an administrator.", STATUS_CODES.FORBIDDEN);
    }
    throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
  }

  private client(): Pick<ShopifyClient, "query"> {
    try {
      return this.getShopifyClient();
    } catch (error) {
      if (error instanceof ShopifyConfigError) throw new ApiError("Shopify is not configured, so the amount cannot be reviewed. Nothing was changed.", STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
  }

  /** Fetches the latest CRM, Shopify and Shiprocket records and compares the money. Read-only. */
  async preview(user: AuthUser, orderId: string): Promise<AmountPreview> {
    return this.previewOf(user, await this.load(user, orderId, "review"));
  }

  private async previewOf(user: AuthUser, order: AmountOrder): Promise<AmountPreview> {
    const canExecute = EDIT_ROLES.includes(user.role);
    const empty = (note: string): AmountPreview => ({ orderId: order.id, orderNumber: order.orderNumber, comparable: false, note, rows: [], proposal: null, manualReason: null, gates: [], canApply: false, blockedReason: note, canExecute, stateToken: null, lastReviewedAt: null, courier: null });
    if (!order.externalId) return empty("This CRM order is not linked to a Shopify order, so there is no Shopify amount to compare.");
    if (order.source !== "SALESPERSON") return empty("This order was placed on the Shopify store; Shopify is the source of truth for its amount.");
    let shop: SyncShopifyOrder;
    try {
      shop = await readSyncOrder(this.client(), order.externalId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ShopifySyncReadError && /no longer has/i.test(error.message)) {
        throw new ApiError("The Shopify order linked to this CRM order no longer exists in Shopify (it may have been deleted or merged). Nothing was changed.", STATUS_CODES.CONFLICT, { code: "SHOPIFY_ORDER_MISSING" });
      }
      throw new ApiError(`Shopify could not be read: ${firstLine(error)}. Nothing was changed.`, 502);
    }
    // courier (read-only). A failure is shown, and blocks the correction.
    let lookups: ShiprocketOrderLookup[] = [];
    let courierError: string | null = null;
    try {
      lookups = await this.courier(shop.name);
    } catch (error) {
      courierError = firstLine(error);
    }
    return buildAmountPreview(order, shop, { lookups, error: courierError }, canExecute, this.lastReviewed(order));
  }

  private lastReviewed(order: AmountOrder): string | null {
    const v = (order.metadata as Record<string, unknown> | null)?.amountReview as { lastCorrectedAt?: unknown } | undefined;
    return typeof v?.lastCorrectedAt === "string" ? v.lastCorrectedAt : null;
  }

  /** Performs the correction. Admin / Manager only; needs the explicit confirmation of the new total and a current token. */
  async apply(user: AuthUser, orderId: string, input: { stateToken: string; confirmTotal: string; confirm: boolean }): Promise<AmountApplyResponse> {
    this.assertRole(user);
    if (!EDIT_ROLES.includes(user.role)) throw new ApiError("Only an Admin or Manager can correct an order amount.", STATUS_CODES.FORBIDDEN);
    if (input.confirm !== true) throw new ApiError("Confirm the change explicitly before anything is edited.", STATUS_CODES.BAD_REQUEST);
    await this.load(user, orderId);
    return withOrderEditClaim(this.db, orderId, async () => {
      const order = await this.load(user, orderId);
      const before = await this.previewOf(user, order);
      if (before.stateToken !== input.stateToken) throw new ApiError("The order, Shopify or Shiprocket changed since the comparison was shown. Refresh it and review again.", STATUS_CODES.CONFLICT, { code: "STALE_PREVIEW" });
      if (!before.proposal) throw new ApiError("There is nothing this action may correct on this order.", STATUS_CODES.CONFLICT);
      if (!before.canApply) throw new ApiError(`The correction is blocked: ${before.blockedReason}`, STATUS_CODES.CONFLICT, { code: "BLOCKED" });
      if (input.confirmTotal.trim() !== before.proposal.after.total) throw new ApiError(`The confirmed total (${input.confirmTotal}) is not the corrected total (${before.proposal.after.total}). Nothing was changed.`, STATUS_CODES.BAD_REQUEST);

      const client = this.client();
      const proposal = before.proposal;
      const amountCents = toCents(proposal.amount);
      const beforeTotal = toCents(proposal.before.total);
      let failure: string | null = null;
      try {
        await addShippingLineToOrder(client, order.externalId!, { title: proposal.title, amountCents, currency: proposal.currency, expectedTotalCents: beforeTotal + amountCents, staffNote: `Shipping ${proposal.amount} added from the CRM (${order.orderNumber}) by ${user.username}` });
      } catch (error) {
        failure = `Shopify did not apply the edit: ${firstLine(error)}`;
      }

      // Re-read Shopify and verify; the result is only a success if Shopify shows it.
      let after: SyncShopifyOrder | null = null;
      try {
        after = await readSyncOrder(client, order.externalId!);
      } catch (error) {
        failure = failure ?? `The edit was sent but Shopify could not be re-read to verify it: ${firstLine(error)}`;
      }
      let verified = false;
      if (after && !failure) {
        verified = after.shippingLineCount === proposal.before.shippingLines + 1 && after.shippingCents === amountCents && after.totalCents === beforeTotal + amountCents && after.outstandingCents === toCents(proposal.after.outstanding) && after.currentTotalCents === beforeTotal + amountCents
          && after.transactionCount === 0 && !/^(paid|partially_paid)$/i.test(after.financialStatus ?? "") && (after.fulfillmentStatus ?? "UNFULFILLED") === "UNFULFILLED" && !after.cancelledAt;
        if (!verified) failure = "Shopify accepted the edit but the re-read does not show the expected shipping line, total and outstanding balance (or shows a payment / fulfilment change).";
      }
      const afterView = after ? { total: money(after.totalCents), outstanding: money(after.outstandingCents), shippingLines: after.shippingLineCount } : null;
      await this.record(user, order, proposal, failure ? "failed" : "corrected", failure, afterView);
      const fresh = await this.previewOf(user, await this.load(user, orderId));
      if (failure) {
        return { outcome: "failed", message: `${failure} The CRM was not changed.`, before: proposal.before, after: afterView, preview: fresh };
      }
      return { outcome: "corrected", message: `Added the ${proposal.amount} shipping line. Shopify now shows total ${afterView!.total} and outstanding ${afterView!.outstanding} (verified).`, before: proposal.before, after: afterView, preview: fresh };
    });
  }

  private async record(user: AuthUser, order: AmountOrder, proposal: AmountProposal, outcome: string, failure: string | null, after: { total: string; outstanding: string; shippingLines: number } | null): Promise<void> {
    try {
      await this.db.activity.create({
        data: {
          leadId: order.leadId, orderId: order.id, actorId: user.id, actorRole: user.role, type: ActivityType.NOTE, referenceType: "Order", referenceId: order.id, source: ActivitySource.USER,
          title: `Amount ${outcome === "corrected" ? "corrected" : "correction FAILED"} on ${order.externalNumber ?? order.orderNumber}: shipping ${proposal.amount} ${outcome === "corrected" ? "added to Shopify" : "not added"}`,
          description: failure ?? `${proposal.reason} Shopify total ${proposal.before.total} -> ${after?.total}.`,
          oldValue: proposal.before as unknown as Prisma.InputJsonValue, newValue: { outcome, after, failure, at: this.now().toISOString() } as unknown as Prisma.InputJsonValue,
        },
      });
      if (outcome === "corrected") {
        const patch = JSON.stringify({ lastCorrectedAt: this.now().toISOString(), by: user.id, kind: proposal.kind, amount: proposal.amount });
        await this.db.$executeRaw`UPDATE orders SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{amountReview}', ${patch}::jsonb) WHERE id = ${order.id}::uuid`;
      }
    } catch (error) {
      logger.error(`Could not record the amount correction on order ${order.orderNumber}`, firstLine(error));
    }
  }
}

/** The whole comparison as pure data from the three records. Exported for tests and for the dry-run report. */
export function buildAmountPreview(order: AmountOrder, shop: SyncShopifyOrder, courier: { lookups: ShiprocketOrderLookup[]; error: string | null }, canExecute: boolean, lastReviewedAt: string | null): AmountPreview {
  const crmTotal = toCents(order.totalAmount.toString());
  const crmShip = toCents(order.shippingAmount.toString());
  const crmDisc = toCents(order.discountAmount.toString());
  const crmTax = toCents(order.taxAmount.toString());
  const paidCrm = order.payments.some((p) => p.status === PaymentStatus.SUCCESS);
  const crmOutstanding = paidCrm ? 0 : crmTotal;
  const refunds = shop.refundedCents > 0 || order._count.refundRequests > 0 || order.payments.some((p) => p.status === PaymentStatus.REFUNDED || p.status === PaymentStatus.PARTIALLY_REFUNDED);
  const cancelled = Boolean(shop.cancelledAt) || order.status === OrderStatus.CANCELLED;
  const isCod = (order.metadata as Record<string, unknown> | null)?.paymentMode === "COD";

  // line items: CRM catalogue lines vs Shopify lines (variant x quantity x unit price)
  const crmLines = new Map<string, { q: number; p: number }>();
  let custom = 0;
  for (const i of order.items) {
    if (i.variant?.externalId && i.variant.externalSource === "SHOPIFY") {
      const k = `gid://shopify/ProductVariant/${i.variant.externalId}`;
      const cur = crmLines.get(k) ?? { q: 0, p: toCents(i.unitPrice.toString()) };
      cur.q += i.quantity;
      crmLines.set(k, cur);
    } else custom += 1;
  }
  const shopLines = new Map<string, { q: number; p: number }>();
  for (const l of shop.lines) if (l.variantId) { const cur = shopLines.get(l.variantId) ?? { q: 0, p: l.unitPriceCents }; cur.q += l.quantity; shopLines.set(l.variantId, cur); }
  const linesSame = custom === 0 && crmLines.size === shopLines.size && [...crmLines].every(([k, v]) => shopLines.get(k)?.q === v.q && shopLines.get(k)?.p === v.p);
  const fmtLines = (m: Map<string, { q: number; p: number }>) => [...m].map(([k, v]) => `${k.split("/").pop()} x ${v.q} @ ${money(v.p)}`).join(", ") || "(none)";

  const row = (key: string, label: string, crm: string, shopify: string, same: boolean): AmountRow => ({ key, label, crm, shopify, status: same ? "SAME" : "DIFFERENT" });
  const rows: AmountRow[] = [
    row("items", "Line items (variant x qty @ price)", custom ? `${fmtLines(crmLines)} (+${custom} custom)` : fmtLines(crmLines), fmtLines(shopLines), linesSame),
    row("discount", "Discount", money(crmDisc), money(shop.discountsCents), crmDisc === shop.discountsCents),
    row("shipping", "Shipping", money(crmShip), `${money(shop.shippingCents)} (${shop.shippingLineCount} line${shop.shippingLineCount === 1 ? "" : "s"})`, crmShip === shop.shippingCents),
    row("tax", "Tax", money(crmTax), money(shop.taxCents), crmTax === shop.taxCents),
    row("refunds", "Refunded", money(0), money(shop.refundedCents), shop.refundedCents === 0),
    row("total", "Total", money(crmTotal), money(shop.totalCents), crmTotal === shop.totalCents || crmTotal === shop.currentTotalCents),
    row("outstanding", "Outstanding balance", money(crmOutstanding), money(shop.outstandingCents), crmOutstanding === shop.outstandingCents),
  ];

  // The one correction this action may offer.
  const diff = crmTotal - shop.totalCents;
  const supported = crmShip > 0 && shop.shippingCents === 0 && shop.shippingLineCount === 0 && diff === crmShip && crmDisc === shop.discountsCents && crmTax === shop.taxCents && linesSame && shop.refundedCents === 0;
  const currency = shop.currency ?? order.currency;
  const proposal: AmountProposal | null = supported
    ? {
        kind: "ADD_SHIPPING_LINE", title: "Shipping", amount: money(crmShip), currency,
        before: { total: money(shop.totalCents), outstanding: money(shop.outstandingCents), shippingLines: shop.shippingLineCount },
        after: { total: money(shop.totalCents + crmShip), outstanding: money(shop.outstandingCents + crmShip), shippingLines: 1 },
        reason: `The CRM charges shipping ${money(crmShip)} (the flat COD shipping rule) but the Shopify order has no shipping line, so Shopify asks for ${money(shop.totalCents)} where the CRM expects ${money(crmTotal)}.`,
        risk: `This RAISES what the customer owes from ${money(shop.outstandingCents)} to ${money(shop.outstandingCents + crmShip)}. The courier must already be set to collect the corrected amount; this action never changes a courier / COD amount, records no payment and marks nothing paid.`,
      }
    : null;
  const why = explainMoney({ id: order.id, orderNumber: order.orderNumber, externalId: order.externalId ?? "", externalNumber: order.externalNumber, status: order.status, currency: order.currency, totalCents: crmTotal, shippingCents: crmShip, discountCents: crmDisc, taxCents: crmTax, paymentStatuses: [], paymentMode: null, shipmentCount: 0, refundRequestCount: 0, lead: { id: order.lead.id, firstName: order.lead.firstName, lastName: order.lead.lastName, normalizedMobile: order.lead.normalizedMobile, email: order.lead.email } },
    { id: shop.id, name: shop.name, cancelledAt: shop.cancelledAt, financialStatus: shop.financialStatus, fulfillmentStatus: shop.fulfillmentStatus, currency: shop.currency, totalCents: shop.totalCents, currentTotalCents: shop.currentTotalCents, shippingCents: shop.shippingCents, discountsCents: shop.discountsCents, taxCents: shop.taxCents, refundedCents: shop.refundedCents, customer: null });
  const anyDifference = rows.some((r) => r.status === "DIFFERENT");
  const manualReason = proposal ? null : anyDifference ? `${why ? `${why.reason}. ` : ""}This kind of difference is not corrected by this action - it needs a person to decide and, if needed, make an explicit Shopify order edit.` : null;

  // courier
  const target = proposal ? toCents(proposal.after.total) : crmTotal;
  const exact = courier.lookups;
  const c = exact.length === 1 ? exact[0]! : null;
  const courierView: AmountPreview["courier"] = { found: exact.length > 0, status: c?.status ?? null, paymentMethod: c?.paymentMethod ?? null, total: c?.totalCents != null ? money(c.totalCents) : null, hasAwb: Boolean(c?.awb || c?.courier), error: courier.error };

  const gates: AmountGate[] = [];
  const gate = (key: string, label: string, ok: boolean, detail: string) => gates.push({ key, label, ok, detail });
  gate("not_cancelled", "Order not cancelled", !cancelled, cancelled ? "The order is cancelled." : "Not cancelled.");
  gate("unfulfilled", "Not fulfilled in Shopify", !shop.fulfillmentStatus || shop.fulfillmentStatus === "UNFULFILLED", `Shopify fulfilment: ${shop.fulfillmentStatus?.toLowerCase().replace(/_/g, " ") ?? "unfulfilled"}.`);
  gate("no_shipment", "No CRM shipment", order.shipments.length === 0, order.shipments.length ? "A shipment exists in the CRM." : "No shipment.");
  gate("status", "CRM order is open", EDITABLE_STATUSES.includes(order.status), `CRM status: ${order.status.toLowerCase().replace(/_/g, " ")}.`);
  gate("unpaid", "Nothing paid or received", !paidCrm && shop.outstandingCents === shop.totalCents && shop.transactionCount === 0 && !/^(paid|partially_paid|refunded|partially_refunded)$/i.test(shop.financialStatus ?? ""), paidCrm || shop.transactionCount > 0 ? "A payment is recorded." : "No payment recorded.");
  gate("no_refund", "No refund", !refunds, refunds ? "A refund is recorded or requested." : "No refund.");
  gate("cod", "Cash on delivery order", isCod, isCod ? "COD." : "Not a COD order.");
  if (courier.error) gate("courier", "Courier amount verified", false, `The Shiprocket amount could not be verified: ${courier.error}.`);
  else if (exact.length > 1) gate("courier", "Courier amount verified", false, `${exact.length} Shiprocket orders match this order; the amount cannot be established.`);
  else if (!c) gate("courier", "Courier amount verified", true, "No Shiprocket order has been imported yet, so there is no courier amount to disagree with.");
  else {
    const nonCod = !/cod/i.test(c.paymentMethod ?? "");
    const shipped = Boolean(c.awb || c.courier) || !/^new$/i.test(c.status ?? "");
    const amountOk = c.totalCents === target;
    gate("courier", "Courier amount agrees", !nonCod && !shipped && amountOk,
      nonCod ? `Shiprocket has this order as ${c.paymentMethod ?? "unknown"}, not COD.` : shipped ? `Shiprocket already has a courier / AWB or the order is ${c.status}; its amount can no longer be aligned safely.`
        : amountOk ? `Shiprocket COD amount is ${money(c.totalCents!)} - the same as the corrected total.` : `Shiprocket's COD amount is ${c.totalCents == null ? "unknown" : money(c.totalCents)}, not ${money(target)}. Update the Shiprocket order (or re-import it) to ${money(target)} first - this action never changes a courier amount - then review again.`);
  }
  gate("role", "You may apply this", canExecute, canExecute ? "Admin / Manager." : "Only an Admin or Manager can correct an amount.");

  const failed = gates.find((g) => !g.ok);
  const blockedReason = !proposal ? (manualReason ?? "Nothing to correct.") : failed ? `${failed.label}: ${failed.detail}` : null;
  const snapshot = {
    crm: { total: crmTotal, ship: crmShip, disc: crmDisc, tax: crmTax, lines: [...crmLines], status: order.status, paid: paidCrm, shipments: order.shipments.length },
    shop: { upd: shop.updatedAt, total: shop.totalCents, outstanding: shop.outstandingCents, ship: shop.shippingCents, lines: shop.shippingLineCount, ful: shop.fulfillmentStatus, fin: shop.financialStatus, cancelled: shop.cancelledAt, tx: shop.transactionCount },
    courier: exact.map((x) => [x.shiprocketOrderId, x.status, x.totalCents, x.awb, x.courier]), courierError: courier.error,
  };
  return {
    orderId: order.id, orderNumber: order.orderNumber, comparable: true, note: null, rows, proposal, manualReason, gates,
    canApply: Boolean(proposal) && !failed, blockedReason, canExecute, stateToken: stateToken(snapshot), lastReviewedAt, courier: courierView,
  };
}

export default OrderAmountService;
