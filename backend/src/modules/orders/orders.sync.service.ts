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
import { toCents } from "../shopify/shopify.money.js";
import { fixOrderCustomer, sameFirstName } from "../shopify/shopify.customer-repair.js";
import { mapAddress, INDIAN_PROVINCE_CODES, orderSourceLabel, provinceCodeFor, type CrmOrderForShopify, type MappingReport } from "../shopify/shopify.order-mapping.js";
import { classifyOrder, crmHasCustomerName, explainMoney, type AuditCrmOrder } from "../shopify/shopify.order-audit.js";
import { crmAddress, loadCrmAuditOrders, loadShopifyAuditOrders, type ReadDb } from "../shopify/shopify.order-audit.load.js";
import { addressDifferences, addressText, categoryOf, comparableAddress, stateToken, SYNC_ACTIONS, SYNC_CATEGORY_LABEL, type SyncActionId, type SyncCategory, type SyncItem } from "../shopify/shopify.order-sync.compare.js";
import { readSyncOrder, ShopifySyncReadError, type SyncShopifyOrder } from "../shopify/shopify.order-sync.read.js";
import { updateOrderShippingAddress } from "../shopify/shopify.orders.edit.js";
import { addShopifyOrderTags } from "../shopify/shopify.orders.write.js";
import { creatorTagFor } from "./orders.creator-tag.js";
import { canViewAllOrders, orderActionWhere } from "./orders.filters.js";
import { withOrderEditClaim } from "./orders.claim.js";

// SYNC / UPDATE FROM CRM (order page). Compares the CRM order with the live Shopify order, lets the person pick the differences the sync is ALLOWED to write, and writes only those - after an explicit confirmation, on a
// fresh comparison, under the same per-order claim as the flavour / address edits. The field map (who owns what, what is safe) is documented in shopify.order-sync.compare.ts.
//
// What it can write:   customer link / blank customer name, shipping address, missing tags (add-only).
// What it never does:  collect or change a payment, refund, cancel, change fulfilment or shipments / courier COD, touch a total, shipping line, discount, tax or line item, create a second order, or send a WhatsApp
//                      message. Those differences are listed with the reason and left for a person (manual review / an explicit order edit).
// Every apply is re-read from Shopify and verified; the initiator, the changes and the result (including failures) go to the order's history.

const EDITABLE_STATUSES: OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED, OrderStatus.PROCESSING];
const money = (c: number) => (c / 100).toFixed(2);
const low = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
const NL = String.fromCharCode(10);
const firstLine = (e: unknown) => (e instanceof Error ? e.message.split(NL).join(" ").slice(0, 300) : "unknown error");

const SYNC_SELECT = {
  id: true, orderNumber: true, status: true, source: true, currency: true, externalId: true, externalNumber: true, leadId: true,
  subtotal: true, discountAmount: true, shippingAmount: true, taxAmount: true, totalAmount: true, shippingAddress: true, shippingPincode: true, metadata: true,
  conversation: { select: { id: true } },
  lead: { select: { id: true, firstName: true, lastName: true, email: true, normalizedMobile: true, mobile: true, leadNumber: true } },
  items: { select: { itemType: true, quantity: true, variant: { select: { externalId: true, externalSource: true } } } },
  shipments: { select: { id: true } },
  payments: { select: { status: true } },
  _count: { select: { refundRequests: true } },
} satisfies Prisma.OrderSelect;
type SyncOrder = Prisma.OrderGetPayload<{ select: typeof SYNC_SELECT }>;

export interface SyncPreview {
  orderId: string;
  orderNumber: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  /** false when there is nothing to compare (not linked to Shopify, or a Shopify-origin order). */
  comparable: boolean;
  note: string | null;
  items: SyncItem[];
  summary: { inSync: number; differences: number; syncable: number; manualReview: number };
  /** Fingerprint of what was compared; send it back when applying so a changed order is refused. */
  stateToken: string | null;
  lastSyncedAt: string | null;
  orderState: { cancelled: boolean; fulfillment: string | null; financial: string | null; shipments: number; refunds: boolean } | null;
}

export type ApplyResultStatus = "applied" | "blocked" | "failed";
export interface ApplyResult { action: SyncActionId; status: ApplyResultStatus; message: string }
export interface SyncApplyResponse {
  outcome: "synced" | "partial" | "failed" | "blocked";
  message: string;
  results: ApplyResult[];
  /** The order compared again after the changes (Shopify re-read), with a new token. */
  preview: SyncPreview;
}

const ACTION_ITEM: Record<SyncActionId, string> = { "customer.link": "customer.link", "customer.name": "customer.name", "shipping.address": "shipping.address", "tags.add": "tags" };

function expectedTags(order: SyncOrder): string[] {
  const forLabel = { metadata: (order.metadata as Record<string, unknown> | null) ?? null, fromAiConversation: Boolean(order.conversation) };
  const c = (order.metadata as Record<string, unknown> | null)?.createdBy as { name?: unknown } | undefined;
  const creator = typeof c?.name === "string" && c.name.trim() ? c.name.trim() : null;
  return ["CRM", orderSourceLabel(forLabel).tag, ...(creator ? [creatorTagFor(creator)] : [])];
}

/** Everything the comparison decides, as pure data, from the two records. */
export function buildPreview(order: SyncOrder, shop: SyncShopifyOrder, lastSyncedAt: string | null = null): SyncPreview {
  const lead = order.lead;
  const crmName = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  const named = crmHasCustomerName({ firstName: lead.firstName, lastName: lead.lastName, normalizedMobile: lead.normalizedMobile, email: lead.email, id: lead.id });
  const refunds = shop.refundedCents > 0 || order._count.refundRequests > 0 || order.payments.some((p) => p.status === PaymentStatus.REFUNDED || p.status === PaymentStatus.PARTIALLY_REFUNDED);
  const cancelled = Boolean(shop.cancelledAt) || order.status === OrderStatus.CANCELLED;
  const unfulfilled = !shop.fulfillmentStatus || shop.fulfillmentStatus === "UNFULFILLED";
  const crmAddr = crmAddress(order.shippingAddress, order.shippingPincode);

  // Why an order-level write is not allowed right now (null = allowed).
  const openBlock: string | null = cancelled ? "the order is cancelled" : !unfulfilled ? `Shopify shows the order as ${shop.fulfillmentStatus?.toLowerCase().replace(/_/g, " ")}` : order.shipments.length > 0 ? "a shipment exists (correct it with the courier)" : !EDITABLE_STATUSES.includes(order.status) ? `the CRM order is ${order.status.toLowerCase().replace(/_/g, " ")}` : refunds ? "a refund is recorded" : null;
  const customerBlock: string | null = cancelled ? "the order is cancelled" : refunds ? "a refund is recorded" : null;
  const items: SyncItem[] = [];
  const add = (i: SyncItem) => items.push(i);

  // ---- customer
  const c = shop.customer;
  const shopName = c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() : "";
  if (named) {
    add({ key: "customer.link", group: "customer", label: "Shopify customer", crm: `${crmName}${lead.normalizedMobile ? ` (${lead.normalizedMobile})` : ""}`, shopify: c ? (shopName || "(customer with no name)") : "No customer linked", status: c ? "SYNCED" : "DIFFERENT",
      action: !c && !customerBlock ? "customer.link" : null, blocked: !c && customerBlock ? `Not linked automatically: ${customerBlock}.` : null });
  } else {
    add({ key: "customer.link", group: "customer", label: "Shopify customer", crm: "(no real customer name in the CRM)", shopify: c ? shopName || "(customer with no name)" : "No customer linked", status: "INFO", action: null, blocked: null });
  }
  if (c && named) {
    if (!shopName) add({ key: "customer.name", group: "customer", label: "Customer name", crm: crmName, shopify: "(blank)", status: "DIFFERENT", action: customerBlock ? null : "customer.name", blocked: customerBlock ? `Not filled automatically: ${customerBlock}.` : null });
    else if (!sameFirstName(lead.firstName, shopName)) add({ key: "customer.name", group: "customer", label: "Customer name", crm: crmName, shopify: shopName, status: "DIFFERENT", action: null, blocked: "The Shopify customer already has a name; an existing name is never overwritten. Check it is the same person." });
    else add({ key: "customer.name", group: "customer", label: "Customer name", crm: crmName, shopify: shopName, status: "SYNCED", action: null, blocked: null });
  }
  if (c && lead.normalizedMobile) {
    const same = digits(c.phone) === digits(lead.normalizedMobile);
    add({ key: "customer.phone", group: "customer", label: "Customer phone", crm: lead.normalizedMobile, shopify: c.phone ?? "(none)", status: same ? "SYNCED" : "DIFFERENT", action: null, blocked: same ? null : "The phone belongs to the Shopify customer, which can have other orders; change it in Shopify if it is wrong." });
  }
  if (c && lead.email) {
    const same = low(c.email) === low(lead.email);
    add({ key: "customer.email", group: "customer", label: "Customer e-mail", crm: lead.email, shopify: c.email ?? "(none)", status: same ? "SYNCED" : "DIFFERENT", action: null, blocked: same ? null : "The e-mail belongs to the Shopify customer; change it in Shopify if it is wrong." });
  }

  // ---- addresses
  if (crmAddr) {
    const diffs = addressDifferences(crmAddr, shop.shippingAddress);
    const code = provinceCodeFor(String(crmAddr.state ?? ""));
    const stateBad = !code || !INDIAN_PROVINCE_CODES.has(code);
    const blocked = diffs.length === 0 ? null : openBlock ? `Not updated automatically: ${openBlock}.` : stateBad ? "The CRM address has a state Shopify does not recognise; correct it with Edit Address first." : null;
    add({ key: "shipping.address", group: "address", label: "Shipping address", crm: addressText(crmAddr), shopify: addressText(shop.shippingAddress) ?? "(none)", status: diffs.length ? "DIFFERENT" : "SYNCED", action: diffs.length && !blocked ? "shipping.address" : null, blocked });
    const billDiff = shop.billingAddress ? addressDifferences(crmAddr, shop.billingAddress).filter((d) => d !== "recipient name") : ["no billing address in Shopify"];
    add({ key: "billing.address", group: "address", label: "Billing address", crm: "same as shipping (the CRM keeps no separate billing address)", shopify: addressText(shop.billingAddress) ?? "(none)", status: billDiff.length ? "DIFFERENT" : "SYNCED", action: null, blocked: billDiff.length ? "Shopify cannot change a billing address through an order update; edit it in the Shopify admin if needed." : null });
  }

  // ---- order
  const wantTags = expectedTags(order);
  const have = new Set(shop.tags.map((t) => t.toLowerCase()));
  const missing = wantTags.filter((t) => !have.has(t.toLowerCase()));
  add({ key: "tags", group: "order", label: "Tags (CRM, source, creator)", crm: wantTags.join(", "), shopify: shop.tags.join(", ") || "(none)", status: missing.length ? "DIFFERENT" : "SYNCED", action: missing.length && !cancelled ? "tags.add" : null, blocked: missing.length && cancelled ? "Not updated: the order is cancelled." : null });
  const crmLines = new Map<string, number>();
  let custom = 0;
  for (const i of order.items) {
    if (i.variant?.externalId && i.variant.externalSource === "SHOPIFY") crmLines.set(`gid://shopify/ProductVariant/${i.variant.externalId}`, (crmLines.get(`gid://shopify/ProductVariant/${i.variant.externalId}`) ?? 0) + i.quantity);
    else custom += 1;
  }
  const shopLines = new Map<string, number>();
  for (const l of shop.lines) if (l.variantId) shopLines.set(l.variantId, (shopLines.get(l.variantId) ?? 0) + l.quantity);
  const lineDiff = [...new Set([...crmLines.keys(), ...shopLines.keys()])].some((k) => (crmLines.get(k) ?? 0) !== (shopLines.get(k) ?? 0));
  const fmtLines = (m: Map<string, number>) => [...m].map(([k, q]) => `${k.split("/").pop()} x ${q}`).join(", ") || "(none)";
  add({ key: "items", group: "order", label: "Line items (variant x quantity)", crm: `${fmtLines(crmLines)}${custom ? ` (+${custom} custom item${custom > 1 ? "s" : ""})` : ""}`, shopify: fmtLines(shopLines), status: lineDiff ? "DIFFERENT" : "SYNCED", action: null,
    blocked: lineDiff ? "Line items and quantities change only through a Shopify order edit, which can change what the customer owes. A flavour swap at the same price has its own button (Change Flavour); anything else is manual review." : null });

  // ---- financial (never written)
  const crmTotal = toCents(order.totalAmount.toString());
  const crmShip = toCents(order.shippingAmount.toString());
  const crmDisc = toCents(order.discountAmount.toString());
  const crmTax = toCents(order.taxAmount.toString());
  const why = explainMoney({ id: order.id, orderNumber: order.orderNumber, externalId: order.externalId ?? "", externalNumber: order.externalNumber, status: order.status, currency: order.currency, totalCents: crmTotal, shippingCents: crmShip, discountCents: crmDisc, taxCents: crmTax, paymentStatuses: [], paymentMode: null, shipmentCount: 0, refundRequestCount: 0, lead: { id: lead.id, firstName: lead.firstName, lastName: lead.lastName, normalizedMobile: lead.normalizedMobile, email: lead.email } },
    { id: shop.id, name: shop.name, cancelledAt: shop.cancelledAt, financialStatus: shop.financialStatus, fulfillmentStatus: shop.fulfillmentStatus, currency: shop.currency, totalCents: shop.totalCents, currentTotalCents: shop.currentTotalCents, shippingCents: shop.shippingCents, discountsCents: shop.discountsCents, taxCents: shop.taxCents, refundedCents: shop.refundedCents, customer: null });
  const fin = (key: string, label: string, crmC: number, shopC: number, note: string): SyncItem => ({ key, group: "financial", label, crm: money(crmC), shopify: money(shopC), status: crmC === shopC ? "SYNCED" : "DIFFERENT", action: null,
    blocked: crmC === shopC ? null : `${note} This changes what the customer owes (and may already be on a courier COD sheet), so the sync never edits it - a person must approve an explicit Shopify order edit.` });
  add(fin("shipping.line", "Shipping charge", crmShip, shop.shippingCents, "The CRM and Shopify disagree on the shipping charge."));
  add(fin("discount", "Discount", crmDisc, shop.discountsCents, "The CRM and Shopify disagree on the discount."));
  add(fin("tax", "Tax", crmTax, shop.taxCents, "The CRM and Shopify disagree on tax."));
  const totalDiffers = crmTotal !== shop.totalCents && crmTotal !== shop.currentTotalCents;
  add({ key: "total", group: "financial", label: "Order total", crm: money(crmTotal), shopify: money(shop.totalCents), status: totalDiffers ? "DIFFERENT" : "SYNCED", action: null,
    blocked: totalDiffers ? `${why ? `Likely cause: ${why.reason}. ` : ""}The totals are never forced to match: correcting it means an order edit that changes the amount owed. Manual review.` : null });
  const paidCrm = order.payments.some((p) => p.status === PaymentStatus.SUCCESS);
  const paidShop = /^(paid|partially_paid)$/i.test(shop.financialStatus ?? "");
  add({ key: "payment", group: "financial", label: "Payment status", crm: paidCrm ? "paid" : "not paid", shopify: shop.financialStatus?.toLowerCase().replace(/_/g, " ") ?? "unknown", status: paidCrm === paidShop ? "SYNCED" : "DIFFERENT", action: null, blocked: paidCrm === paidShop ? null : "Payment state is never changed by a sync. Reconcile it through the payment workflow." });
  if (shop.refundedCents > 0) add({ key: "refund", group: "financial", label: "Refunded in Shopify", crm: money(0), shopify: money(shop.refundedCents), status: "INFO", action: null, blocked: null });

  // ---- state (information that decides what is editable)
  add({ key: "state", group: "state", label: "Order state", crm: order.status.toLowerCase().replace(/_/g, " "), shopify: [shop.cancelledAt ? "cancelled" : null, shop.fulfillmentStatus?.toLowerCase().replace(/_/g, " "), shop.financialStatus?.toLowerCase().replace(/_/g, " ")].filter(Boolean).join(" / "), status: "INFO", action: null, blocked: null });

  const differences = items.filter((i) => i.status === "DIFFERENT");
  const snapshot = {
    crm: { status: order.status, total: crmTotal, ship: crmShip, disc: crmDisc, tax: crmTax, addr: comparableAddress(crmAddr), lines: [...crmLines], lead: { n: crmName, p: lead.normalizedMobile, e: lead.email }, paid: paidCrm, ships: order.shipments.length },
    shop: { upd: shop.updatedAt, cancelled: shop.cancelledAt, ful: shop.fulfillmentStatus, fin: shop.financialStatus, total: shop.totalCents, ship: shop.shippingCents, cust: c ? [c.id, shopName] : null, addr: comparableAddress(shop.shippingAddress), tags: [...shop.tags].sort(), lines: [...shopLines] },
  };
  return {
    orderId: order.id, orderNumber: order.orderNumber, shopifyOrderId: order.externalId, shopifyOrderName: shop.name, comparable: true, note: null, items,
    summary: { inSync: items.filter((i) => i.status === "SYNCED").length, differences: differences.length, syncable: differences.filter((i) => i.action).length, manualReview: differences.filter((i) => !i.action).length },
    stateToken: stateToken(snapshot), lastSyncedAt,
    orderState: { cancelled, fulfillment: shop.fulfillmentStatus, financial: shop.financialStatus, shipments: order.shipments.length, refunds },
  };
}

export interface SyncReportItem {
  crmOrderId: string;
  crmOrderNumber: string;
  shopifyOrderId: string;
  orderName: string | null;
  customerAssociation: string;
  crmTotal: string;
  shopifyTotal: string;
  difference: string;
  paymentStatus: string;
  fulfilment: string | null;
  category: SyncCategory;
  categoryLabel: string;
  reasons: string[];
  proposedRepair: string;
}
export interface SyncReport {
  generatedAt: string;
  compared: number;
  counts: Record<SyncCategory, number>;
  items: SyncReportItem[];
  notFoundInShopify: string[];
  note: string;
}

export class OrderSyncService {
  private reportCache: { at: number; value: SyncReport } | null = null;

  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => Pick<ShopifyClient, "query"> = () => new ShopifyClient(loadShopifyConfig()),
    private readonly now: () => Date = () => new Date(),
    private readonly retryDelayMs: number = 1500,
  ) {}

  private assertRole(user: AuthUser): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER && user.role !== Role.SALESPERSON) throw new ApiError("You do not have permission to sync orders", STATUS_CODES.FORBIDDEN);
  }

  /**
   * The CRM order. "review" (the comparison, read-only) follows the same visibility as opening the order page - company-wide for Admin, Manager and Telecaller - so anyone who can see the order can see its comparison.
   * "act" (anything that writes) keeps the strict action scope: the creator, the owner's team, an admin. An order that exists but is outside that scope is answered with a clear 403, not "Order not found", which
   * is reserved for an order that really does not exist.
   */
  private async load(user: AuthUser, orderId: string, mode: "review" | "act" = "act"): Promise<SyncOrder> {
    this.assertRole(user);
    const leadScope = await getLeadScope(user, this.db);
    const team = user.role === Role.MANAGER ? await getManagerTeam(user.id, this.db) : undefined;
    const where = mode === "review" && canViewAllOrders(user.role) ? { id: orderId } : orderActionWhere(user, orderId, leadScope, team?.members.map((m) => m.id) ?? []);
    const order = await this.db.order.findFirst({ where, select: SYNC_SELECT });
    if (order) return order;
    if (mode === "act" && canViewAllOrders(user.role) && (await this.db.order.findFirst({ where: { id: orderId }, select: { id: true } }))) {
      throw new ApiError("You can review this order, but you can only change orders you created or that belong to your team or lead scope. Ask the order's creator, their manager or an administrator to run the sync.", STATUS_CODES.FORBIDDEN);
    }
    throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
  }

  private client(): Pick<ShopifyClient, "query"> {
    try {
      return this.getShopifyClient();
    } catch (error) {
      if (error instanceof ShopifyConfigError) throw new ApiError("Shopify is not configured, so the order cannot be compared. Nothing was changed.", STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
  }

  private async readShop(client: Pick<ShopifyClient, "query">, externalId: string): Promise<SyncShopifyOrder> {
    try {
      return await readSyncOrder(client, externalId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ShopifySyncReadError && /no longer has/i.test(error.message)) {
        throw new ApiError("The Shopify order linked to this CRM order no longer exists in Shopify (it may have been deleted or merged). Nothing was changed.", STATUS_CODES.CONFLICT, { code: "SHOPIFY_ORDER_MISSING" });
      }
      throw new ApiError(`Shopify could not be read: ${firstLine(error)}. Nothing was changed.`, 502);
    }
  }

  private notComparable(order: SyncOrder, note: string): SyncPreview {
    return { orderId: order.id, orderNumber: order.orderNumber, shopifyOrderId: order.externalId, shopifyOrderName: order.externalNumber, comparable: false, note, items: [], summary: { inSync: 0, differences: 0, syncable: 0, manualReview: 0 }, stateToken: null, lastSyncedAt: null, orderState: null };
  }

  private lastSynced(order: SyncOrder): string | null {
    const v = (order.metadata as Record<string, unknown> | null)?.crmSync as { lastSyncedAt?: unknown } | undefined;
    return typeof v?.lastSyncedAt === "string" ? v.lastSyncedAt : null;
  }

  /** Fetches the latest CRM order and the live Shopify order and compares them. Read-only. */
  async preview(user: AuthUser, orderId: string): Promise<SyncPreview> {
    const order = await this.load(user, orderId, "review");
    return this.previewOf(order);
  }

  private async previewOf(order: SyncOrder): Promise<SyncPreview> {
    if (!order.externalId) return this.notComparable(order, "This CRM order is not linked to a Shopify order, so there is nothing to compare. Push it to Shopify first.");
    if (order.source !== "SALESPERSON") return this.notComparable(order, "This order was placed on the Shopify store, so Shopify is its source of truth and there is nothing to sync from the CRM.");
    const shop = await this.readShop(this.client(), order.externalId);
    return buildPreview(order, shop, this.lastSynced(order));
  }

  /** Applies the chosen, allowed differences. Requires explicit confirmation and an up-to-date comparison; verifies by re-reading Shopify; records the outcome. */
  async apply(user: AuthUser, orderId: string, input: { stateToken: string; actions: SyncActionId[]; confirm: boolean }): Promise<SyncApplyResponse> {
    if (input.confirm !== true) throw new ApiError("Confirm the sync explicitly before anything is changed.", STATUS_CODES.BAD_REQUEST);
    const wanted = [...new Set(input.actions)].filter((a): a is SyncActionId => SYNC_ACTIONS.includes(a));
    if (wanted.length === 0) throw new ApiError("Choose at least one change to sync.", STATUS_CODES.BAD_REQUEST);
    await this.load(user, orderId); // role, scope, not found - before anything is claimed
    return withOrderEditClaim(this.db, orderId, async () => {
      const order = await this.load(user, orderId);
      if (!order.externalId || order.source !== "SALESPERSON") throw new ApiError("This order cannot be synced from the CRM.", STATUS_CODES.CONFLICT);
      const client = this.client();
      const shop = await this.readShop(client, order.externalId);
      const before = buildPreview(order, shop, this.lastSynced(order));
      if (before.stateToken !== input.stateToken) throw new ApiError("The order changed since the comparison was shown (in the CRM or in Shopify). Refresh the comparison and review it again.", STATUS_CODES.CONFLICT, { code: "STALE_PREVIEW" });

      const results: ApplyResult[] = [];
      const selectable = new Map(before.items.filter((i) => i.action).map((i) => [i.action as SyncActionId, i]));
      const order_: SyncActionId[] = ["customer.link", "customer.name", "shipping.address", "tags.add"]; // customer first, then address, then tags
      for (const action of order_.filter((a) => wanted.includes(a))) {
        const item = selectable.get(action);
        if (!item) {
          const why = before.items.find((i) => i.key === ACTION_ITEM[action])?.blocked;
          results.push({ action, status: "blocked", message: why ?? "There is nothing to sync for this item, or the order state does not allow it." });
          continue;
        }
        try {
          results.push(await this.execute(client, order, shop, action));
        } catch (error) {
          logger.warn(`Sync ${action} failed for order ${order.orderNumber}: ${firstLine(error)}`);
          results.push({ action, status: "failed", message: firstLine(error) });
        }
      }

      // Re-read Shopify and verify each applied change is now actually in sync.
      let afterPreview: SyncPreview;
      try {
        afterPreview = await this.previewOf(await this.load(user, orderId));
      } catch (error) {
        // Applied but not verifiable: never reported as a success.
        for (const r of results) if (r.status === "applied") { r.status = "failed"; r.message = `Applied, but Shopify could not be re-read to verify it: ${firstLine(error)}`; }
        await this.record(user, order, "failed", results, null, this.now().toISOString());
        throw new ApiError(`The changes were sent but could not be verified: ${firstLine(error)}. Refresh the comparison to see the current state.`, 502);
      }
      for (const r of results) {
        if (r.status !== "applied") continue;
        const now = afterPreview.items.find((i) => i.key === ACTION_ITEM[r.action]);
        if (!now || now.status === "DIFFERENT") {
          r.status = "failed";
          r.message = "Shopify accepted the change but the re-read does not show it.";
        }
      }
      const ok = results.filter((r) => r.status === "applied").length;
      const outcome: SyncApplyResponse["outcome"] = ok === results.length ? "synced" : ok > 0 ? "partial" : results.some((r) => r.status === "failed") ? "failed" : "blocked";
      const stamp = this.now().toISOString();
      await this.record(user, order, outcome, results, ok > 0 ? stamp : null, stamp);
      const refreshed = await this.previewOf(await this.load(user, orderId));
      const message =
        outcome === "synced" ? `Synced ${ok} change${ok > 1 ? "s" : ""} to Shopify and verified them.`
        : outcome === "partial" ? `${ok} of ${results.length} changes were synced and verified; the rest need attention.`
        : outcome === "failed" ? "Nothing was synced - Shopify did not accept the change. Nothing was left half-done in the CRM." : "Nothing was synced - none of the chosen changes is allowed for this order right now.";
      return { outcome, message, results, preview: refreshed };
    });
  }

  private async execute(client: Pick<ShopifyClient, "query">, order: SyncOrder, shop: SyncShopifyOrder, action: SyncActionId): Promise<ApplyResult> {
    const lead: AuditCrmOrder["lead"] = { id: order.lead.id, firstName: order.lead.firstName, lastName: order.lead.lastName, normalizedMobile: order.lead.normalizedMobile, email: order.lead.email };
    const externalId = order.externalId!;
    if (action === "customer.link" || action === "customer.name") {
      const r = await fixOrderCustomer({ client, retryDelayMs: this.retryDelayMs }, { plan: action === "customer.link" ? "LINK_OR_CREATE_CUSTOMER" : "FILL_CUSTOMER_NAME", externalId, lead, shopifyCustomer: shop.customer ? { id: shop.customer.id } : null }, { apply: true });
      if (r.status === "repaired") return { action, status: "applied", message: r.changes.join("; ") || r.reason };
      return { action, status: r.status === "failed" ? "failed" : "blocked", message: r.reason };
    }
    if (action === "shipping.address") {
      const forMapping: CrmOrderForShopify = {
        orderNumber: order.orderNumber, currency: order.currency, subtotal: order.subtotal.toString(), discountAmount: order.discountAmount.toString(), discountReason: null, shippingAmount: order.shippingAmount.toString(),
        taxAmount: order.taxAmount.toString(), totalAmount: order.totalAmount.toString(), shippingAddress: (order.shippingAddress as Record<string, unknown> | null) ?? null, shippingPincode: order.shippingPincode, metadata: null, paymentMethod: null, paymentSucceeded: false, fromAiConversation: false,
        lead: { firstName: order.lead.firstName, lastName: order.lead.lastName, leadNumber: order.lead.leadNumber, email: order.lead.email, normalizedMobile: order.lead.normalizedMobile, mobile: order.lead.mobile }, items: [],
      };
      const report: MappingReport = { fields: {} };
      const { shipping } = mapAddress(forMapping, report);
      if (!shipping) return { action, status: "blocked", message: "The CRM address is incomplete, so it was not sent." };
      await updateOrderShippingAddress(client, externalId, shipping); // read back and verified inside
      return { action, status: "applied", message: "Shipping address updated in Shopify (billing address unchanged)." };
    }
    const have = new Set(shop.tags.map((t) => t.toLowerCase()));
    const missing = expectedTags(order).filter((t) => !have.has(t.toLowerCase()));
    await addShopifyOrderTags(client as ShopifyClient, externalId, missing);
    return { action, status: "applied", message: `Added tag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` };
  }

  /** History + "last sync" on the order. The audit row is written for every apply, successful or not. */
  private async record(user: AuthUser, order: SyncOrder, outcome: string, results: ApplyResult[], lastSyncedAt: string | null, attemptedAt: string): Promise<void> {
    try {
      await this.db.activity.create({
        data: {
          leadId: order.leadId, orderId: order.id, actorId: user.id, actorRole: user.role, type: ActivityType.NOTE, referenceType: "Order", referenceId: order.id, source: ActivitySource.USER,
          title: `Sync from CRM to Shopify (${outcome}) on ${order.externalNumber ?? order.orderNumber}`, description: results.map((r) => `${r.action}: ${r.status} - ${r.message}`).join(NL).slice(0, 2000),
          newValue: { outcome, results } as unknown as Prisma.InputJsonValue,
        },
      });
      const patch = JSON.stringify({ ...(lastSyncedAt ? { lastSyncedAt } : {}), lastAttemptAt: attemptedAt, lastOutcome: outcome, by: user.id });
      await this.db.$executeRaw`UPDATE orders SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{crmSync}', COALESCE(metadata->'crmSync', '{}'::jsonb) || ${patch}::jsonb) WHERE id = ${order.id}::uuid`;
    } catch (error) {
      logger.error(`Could not record the sync result on order ${order.orderNumber}`, firstLine(error));
    }
  }

  // ------------------------------------------------------------------------------------------------ mismatch report
  /** READ-ONLY report of every CRM order pushed to Shopify, bucketed by what (if anything) is out of sync. Admin and Manager only. Cached for a minute. */
  async report(user: AuthUser, opts: { fresh?: boolean } = {}): Promise<SyncReport> {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) throw new ApiError("Only Admin and Manager can view the sync report", STATUS_CODES.FORBIDDEN);
    if (!opts.fresh && this.reportCache && this.now().getTime() - this.reportCache.at < 60_000) return this.reportCache.value;
    const crmOrders = await loadCrmAuditOrders(this.db as unknown as ReadDb);
    const shop = await loadShopifyAuditOrders(this.client(), crmOrders.map((o) => o.externalId));
    const counts: Record<SyncCategory, number> = { SYNCED: 0, SAFE_CUSTOMER: 0, SAFE_ADDRESS: 0, FINANCIAL: 0, CONFLICT: 0, AMBIGUOUS_CUSTOMER: 0 };
    const items: SyncReportItem[] = [];
    const notFound: string[] = [];
    for (const crm of crmOrders) {
      const s = shop.get(crm.externalId);
      if (!s) { notFound.push(crm.orderNumber); continue; }
      const r = classifyOrder(crm, s);
      const category = categoryOf(r);
      counts[category] += 1;
      if (category === "SYNCED") continue;
      const proposed =
        category === "FINANCIAL" ? `${r.money!.reason}. Needs a person to approve an explicit Shopify order edit; the sync never changes the amount owed.`
        : category === "CONFLICT" ? `Restricted state (${r.reviewReasons.join("; ")}) - handle manually.`
        : category === "SAFE_CUSTOMER" ? "Open the order and use Sync from CRM: link / create the Shopify customer or fill its blank name."
        : "Open the order and use Sync from CRM: update the Shopify shipping address.";
      items.push({
        crmOrderId: crm.id, crmOrderNumber: crm.orderNumber, shopifyOrderId: crm.externalId, orderName: s.name, customerAssociation: s.customer ? (s.customer.firstName || s.customer.lastName ? "linked, named" : "linked, NO NAME") : "NOT LINKED",
        crmTotal: money(r.crmTotalCents), shopifyTotal: money(r.shopifyTotalCents), difference: money(r.differenceCents), paymentStatus: crm.paymentStatuses.join("+") || "NONE", fulfilment: s.fulfillmentStatus,
        category, categoryLabel: SYNC_CATEGORY_LABEL[category], reasons: [...(r.money ? [r.money.reason] : []), ...r.reviewReasons, ...(r.customerIssue ? [r.customerIssue === "NO_CUSTOMER" ? "no Shopify customer" : "customer has no name"] : []), ...(r.addressDiffers ? ["shipping address differs"] : [])], proposedRepair: proposed,
      });
    }
    const value: SyncReport = {
      generatedAt: this.now().toISOString(), compared: crmOrders.length - notFound.length, counts, items, notFoundInShopify: notFound,
      note: "Read-only. A customer whose phone matches several Shopify customers (or none yet) is only detected when the order is previewed or the repair dry run is run, so 'Customer match failed or ambiguous' is not counted here.",
    };
    this.reportCache = { at: this.now().getTime(), value };
    return value;
  }
}

export default OrderSyncService;
