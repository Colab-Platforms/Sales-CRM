import { ActivityType, ExternalSource, LeadWorkingStatus, OrderStatus, PaymentStatus, ProductStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { normalizeEmail, normalizeMobile } from "../../lib/leadIdentity.js";
import type { MappedLeadIdentity, MappedOrder, MappedPayment, MappedProduct } from "./shopify.mapper.js";

// Writes mapped Shopify data into the CRM. Every function takes a transaction from the caller and is safe to
// run repeatedly: records are found by their Shopify id, so a second run updates or skips, never duplicates.
// Only rows that carry externalSource = SHOPIFY are ever changed or removed; CRM-created rows are left alone.

export type Db = Prisma.TransactionClient;

/** Anything that can run a callback in a transaction; a PrismaClient does, and so can a test wrapper. */
export interface TxRunner {
  $transaction<T>(fn: (tx: Db) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const SOURCE = ExternalSource.SHOPIFY;
export const SHOPIFY_SOURCE_CODE = "SHOPIFY";
export const ORDER_REFERENCE_TYPE = "Order";

const extKey = (externalId: string) => ({ externalSource_externalId: { externalSource: SOURCE, externalId } });

/** Serialises work on one record, so a webhook and a manual sync can never interleave on it. */
async function lock(tx: Db, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export type Action = "created" | "updated" | "skipped";

// ---------------------------------------------------------------------------------------------
// Lead (the CRM's customer identity)
// ---------------------------------------------------------------------------------------------

export interface LeadResolution {
  leadId: string;
  action: "created" | "updated" | "matched";
  matchedBy: "externalId" | "phone" | "email" | null;
}

async function ensureShopifySource(tx: Db): Promise<string> {
  const source = await tx.source.upsert({
    where: { code: SHOPIFY_SOURCE_CODE },
    create: { name: "Shopify", code: SHOPIFY_SOURCE_CODE, description: "Customers and orders imported from Shopify" },
    update: {},
    select: { id: true },
  });
  return source.id;
}

/**
 * Finds the CRM lead for a Shopify customer, or creates one. Match order: Shopify customer id, then phone,
 * then email. An existing lead keeps its identity, source and owner; only empty fields are filled in.
 */
export async function resolveLead(
  tx: Db,
  identity: MappedLeadIdentity,
  ctx: { converted: boolean; fallbackKey: string; activityAt: Date },
): Promise<LeadResolution> {
  const mobile = normalizeMobile(identity.phone);
  const email = normalizeEmail(identity.email);
  await lock(tx, `shopify:lead:${identity.externalId ?? mobile ?? email ?? ctx.fallbackKey}`);

  let lead = identity.externalId ? await tx.lead.findUnique({ where: extKey(identity.externalId) }) : null;
  let matchedBy: LeadResolution["matchedBy"] = lead ? "externalId" : null;
  if (!lead && mobile) {
    lead = await tx.lead.findFirst({ where: { normalizedMobile: mobile }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (lead) matchedBy = "phone";
  }
  if (!lead && email) {
    lead = await tx.lead.findFirst({ where: { normalizedEmail: email }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (lead) matchedBy = "email";
  }

  if (lead) {
    const data: Prisma.LeadUpdateInput = {};
    if (identity.externalId && !lead.externalId) {
      data.externalSource = SOURCE;
      data.externalId = identity.externalId;
    }
    if (!lead.mobile && identity.phone && mobile) {
      data.mobile = identity.phone.slice(0, 20);
      data.normalizedMobile = mobile;
    }
    if (!lead.email && identity.email && email) {
      data.email = identity.email.slice(0, 255);
      data.normalizedEmail = email;
    }
    if (!lead.lastName && identity.lastName) data.lastName = identity.lastName.slice(0, 100);
    if (!lead.location && identity.location) data.location = identity.location.slice(0, 255);
    // A Shopify-created lead that was only a sign-up becomes a customer once it has a live order.
    if (lead.externalSource === SOURCE && lead.workingStatus === LeadWorkingStatus.NEW && ctx.converted) {
      data.workingStatus = LeadWorkingStatus.CONVERTED;
    }
    if (!lead.lastActivityAt || lead.lastActivityAt < ctx.activityAt) data.lastActivityAt = ctx.activityAt;

    const changed = Object.keys(data).some((k) => k !== "lastActivityAt");
    if (Object.keys(data).length > 0) await tx.lead.update({ where: { id: lead.id }, data });
    return { leadId: lead.id, action: changed ? "updated" : "matched", matchedBy };
  }

  const sourceId = await ensureShopifySource(tx);
  const baseNumber = identity.externalId ? `SHP-C-${identity.externalId}` : `SHP-O-${ctx.fallbackKey}`;
  const taken = await tx.lead.findUnique({ where: { leadNumber: baseNumber }, select: { id: true } });
  const created = await tx.lead.create({
    data: {
      leadNumber: taken ? `${baseNumber}-${Date.now().toString(36)}` : baseNumber,
      firstName: (identity.firstName?.trim() || email?.split("@")[0] || "Shopify customer").slice(0, 100),
      lastName: identity.lastName?.trim().slice(0, 100) || null,
      mobile: identity.phone ? identity.phone.slice(0, 20) : null,
      normalizedMobile: mobile,
      email: identity.email ? identity.email.slice(0, 255) : null,
      normalizedEmail: email,
      location: identity.location?.slice(0, 255) ?? null,
      sourceId,
      workingStatus: ctx.converted ? LeadWorkingStatus.CONVERTED : LeadWorkingStatus.NEW,
      lastActivityAt: ctx.activityAt,
      externalSource: identity.externalId ? SOURCE : null,
      externalId: identity.externalId,
    },
  });
  return { leadId: created.id, action: "created", matchedBy: null };
}

/**
 * A Shopify customer record (customers/create|update): make sure the lead exists and is linked.
 * With `createIfMissing: false` an unknown customer is left alone and null is returned: that is how a customer from
 * before the sync start date is handled, so an edit in Shopify updates a lead the CRM already has but never imports
 * the historical customer base.
 */
export async function upsertCustomerLead(
  tx: Db,
  identity: MappedLeadIdentity & { externalUpdatedAt: Date },
  opts: { createIfMissing?: boolean } = {},
): Promise<LeadResolution | null> {
  if (opts.createIfMissing === false) {
    const mobile = normalizeMobile(identity.phone);
    const email = normalizeEmail(identity.email);
    const alternatives: Prisma.LeadWhereInput[] = [];
    if (identity.externalId) alternatives.push({ externalSource: SOURCE, externalId: identity.externalId });
    if (mobile) alternatives.push({ normalizedMobile: mobile });
    if (email) alternatives.push({ normalizedEmail: email });
    if (alternatives.length === 0 || !(await tx.lead.findFirst({ where: { OR: alternatives }, select: { id: true } }))) return null;
  }
  return resolveLead(tx, identity, { converted: false, fallbackKey: identity.externalId ?? "unknown", activityAt: identity.externalUpdatedAt });
}

// ---------------------------------------------------------------------------------------------
// Product and variants
// ---------------------------------------------------------------------------------------------

export interface ProductResult {
  action: Action;
  variants: { created: number; updated: number; skipped: number };
}

export async function upsertProduct(tx: Db, mapped: MappedProduct, opts: { force?: boolean } = {}): Promise<ProductResult> {
  await lock(tx, `shopify:product:${mapped.externalId}`);
  const result: ProductResult = { action: "skipped", variants: { created: 0, updated: 0, skipped: 0 } };

  const existing = await tx.product.findUnique({ where: extKey(mapped.externalId), select: { id: true, externalUpdatedAt: true } });
  if (existing && !opts.force && existing.externalUpdatedAt && existing.externalUpdatedAt >= mapped.externalUpdatedAt) {
    return result;
  }

  const fields = {
    name: mapped.name,
    description: mapped.description,
    status: mapped.status,
    basePrice: mapped.basePrice,
    externalUpdatedAt: mapped.externalUpdatedAt,
  };
  const product = existing
    ? await tx.product.update({ where: { id: existing.id }, data: fields, select: { id: true } })
    : await tx.product.create({ data: { ...fields, type: "PRODUCT", externalSource: SOURCE, externalId: mapped.externalId }, select: { id: true } });
  result.action = existing ? "updated" : "created";

  const current = await tx.productVariant.findMany({ where: { externalSource: SOURCE, productId: product.id } });
  const byId = new Map(current.map((v) => [v.externalId, v]));
  const seen = new Set<string>();

  for (const variant of mapped.variants) {
    seen.add(variant.externalId);
    const before = byId.get(variant.externalId);
    const data = { name: variant.name, sku: variant.sku, price: variant.price, status: variant.status, externalUpdatedAt: variant.externalUpdatedAt };
    if (!before) {
      await tx.productVariant.create({ data: { ...data, productId: product.id, externalSource: SOURCE, externalId: variant.externalId } });
      result.variants.created++;
    } else if (
      before.name !== data.name || before.sku !== data.sku || before.status !== data.status ||
      (before.price?.toString() ?? null) !== (data.price === null ? null : Number(data.price).toString())
    ) {
      await tx.productVariant.update({ where: { id: before.id }, data });
      result.variants.updated++;
    } else {
      result.variants.skipped++;
    }
  }

  // A variant removed in Shopify is deactivated, not deleted: past orders still point at it.
  for (const gone of current.filter((v) => v.externalId && !seen.has(v.externalId) && v.status !== ProductStatus.INACTIVE)) {
    await tx.productVariant.update({ where: { id: gone.id }, data: { status: ProductStatus.INACTIVE } });
    result.variants.updated++;
  }
  return result;
}

/** Which of these Shopify product ids the CRM already has. */
export async function knownProductIds(tx: Db, externalIds: string[]): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await tx.product.findMany({ where: { externalSource: SOURCE, externalId: { in: externalIds } }, select: { externalId: true } });
  return new Set(rows.map((r) => r.externalId!));
}

/** When each of these Shopify records was last synced (its Shopify updated-at), keyed by Shopify id. */
export async function knownVersions(tx: Db, kind: "order" | "product", externalIds: string[]): Promise<Map<string, Date>> {
  const versions = new Map<string, Date>();
  if (externalIds.length === 0) return versions;
  const where = { externalSource: SOURCE, externalId: { in: externalIds } };
  const rows =
    kind === "order"
      ? await tx.order.findMany({ where, select: { externalId: true, externalUpdatedAt: true } })
      : await tx.product.findMany({ where, select: { externalId: true, externalUpdatedAt: true } });
  for (const row of rows) if (row.externalId && row.externalUpdatedAt) versions.set(row.externalId, row.externalUpdatedAt);
  return versions;
}

// ---------------------------------------------------------------------------------------------
// Order, items and payments
// ---------------------------------------------------------------------------------------------

export interface OrderResult {
  action: Action;
  orderId: string | null;
  lead: LeadResolution | null;
  items: number;
  payments: { created: number; updated: number; deleted: number };
  shipments: { created: number; updated: number; deleted: number };
}

const PAYMENT_EVENTS = new Set<PaymentStatus>([PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED]);

export async function upsertOrder(tx: Db, mapped: MappedOrder, opts: { force?: boolean } = {}): Promise<OrderResult> {
  await lock(tx, `shopify:order:${mapped.externalId}`);
  const result: OrderResult = {
    action: "skipped",
    orderId: null,
    lead: null,
    items: 0,
    payments: { created: 0, updated: 0, deleted: 0 },
    shipments: { created: 0, updated: 0, deleted: 0 },
  };

  const existing = await tx.order.findUnique({
    where: extKey(mapped.externalId),
    select: {
      id: true,
      status: true,
      leadId: true,
      externalUpdatedAt: true,
      payments: { where: { externalSource: SOURCE }, select: { id: true, externalId: true, status: true } },
      shipments: { where: { externalSource: SOURCE }, select: { id: true, externalId: true } },
    },
  });
  if (existing && !opts.force && existing.externalUpdatedAt && existing.externalUpdatedAt >= mapped.externalUpdatedAt) {
    result.orderId = existing.id;
    return result;
  }

  const lead: LeadResolution = existing
    ? { leadId: existing.leadId, action: "matched", matchedBy: null }
    : await resolveLead(tx, mapped.identity, {
        converted: mapped.status !== OrderStatus.CANCELLED,
        fallbackKey: mapped.externalId,
        activityAt: mapped.externalUpdatedAt,
      });
  result.lead = lead;

  const fields = {
    status: mapped.status,
    currency: mapped.currency,
    subtotal: mapped.subtotal,
    discountAmount: mapped.discountAmount,
    taxAmount: mapped.taxAmount,
    shippingAmount: mapped.shippingAmount,
    totalAmount: mapped.totalAmount,
    discountReason: mapped.discountReason,
    placedAt: mapped.placedAt,
    confirmedAt: mapped.confirmedAt,
    cancelledAt: mapped.cancelledAt,
    cancelReason: mapped.cancelReason,
    externalNumber: mapped.externalNumber,
    externalUpdatedAt: mapped.externalUpdatedAt,
    shippingPincode: mapped.shippingPincode,
    metadata: mapped.metadata as Prisma.InputJsonValue,
    ...(mapped.shippingAddress ? { shippingAddress: mapped.shippingAddress as Prisma.InputJsonValue } : {}),
  };

  const order = existing
    ? await tx.order.update({ where: { id: existing.id }, data: fields, select: { id: true } })
    : await tx.order.create({
        data: {
          ...fields,
          orderNumber: mapped.orderNumber,
          leadId: lead.leadId,
          source: mapped.source,
          createdAt: mapped.createdAt,
          externalSource: SOURCE,
          externalId: mapped.externalId,
        },
        select: { id: true },
      });
  result.action = existing ? "updated" : "created";
  result.orderId = order.id;

  await replaceItems(tx, order.id, mapped, result);
  const paymentEvents = await syncPayments(tx, order.id, mapped, existing?.payments ?? [], result);
  await syncShipments(tx, order.id, mapped, existing?.shipments ?? [], result);
  await recordActivity(tx, order.id, lead.leadId, mapped, existing?.status ?? null, paymentEvents);
  return result;
}

async function replaceItems(tx: Db, orderId: string, mapped: MappedOrder, result: OrderResult): Promise<void> {
  const productIds = [...new Set(mapped.items.map((i) => i.productExternalId).filter((id): id is string => !!id))];
  const variantIds = [...new Set(mapped.items.map((i) => i.variantExternalId).filter((id): id is string => !!id))];
  const [products, variants] = await Promise.all([
    productIds.length ? tx.product.findMany({ where: { externalSource: SOURCE, externalId: { in: productIds } }, select: { id: true, externalId: true } }) : [],
    variantIds.length ? tx.productVariant.findMany({ where: { externalSource: SOURCE, externalId: { in: variantIds } }, select: { id: true, externalId: true } }) : [],
  ]);
  const productByExt = new Map(products.map((p) => [p.externalId, p.id]));
  const variantByExt = new Map(variants.map((v) => [v.externalId, v.id]));

  // Nothing else references order_items, so the set is rebuilt from Shopify's current line items.
  await tx.orderItem.deleteMany({ where: { orderId } });
  await tx.orderItem.createMany({
    data: mapped.items.map((item) => ({
      orderId,
      productId: item.productExternalId ? (productByExt.get(item.productExternalId) ?? null) : null,
      variantId: item.variantExternalId ? (variantByExt.get(item.variantExternalId) ?? null) : null,
      productNameSnapshot: item.productName.slice(0, 200),
      variantNameSnapshot: item.variantName?.slice(0, 200) ?? null,
      skuSnapshot: item.sku?.slice(0, 100) ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountAmount: item.discountAmount,
      taxAmount: item.taxAmount,
      totalPrice: item.totalPrice,
    })),
  });
  result.items = mapped.items.length;
}

interface PaymentEvent {
  payment: MappedPayment;
  from: PaymentStatus | null;
}

async function syncPayments(
  tx: Db,
  orderId: string,
  mapped: MappedOrder,
  current: { id: string; externalId: string | null; status: PaymentStatus }[],
  result: OrderResult,
): Promise<PaymentEvent[]> {
  const events: PaymentEvent[] = [];
  const byExt = new Map(current.map((p) => [p.externalId, p]));

  for (const payment of mapped.payments) {
    const data = {
      status: payment.status,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
      provider: payment.provider?.slice(0, 100) ?? null,
      providerPaymentId: payment.providerPaymentId?.slice(0, 255) ?? null,
      transactionReference: payment.transactionReference?.slice(0, 255) ?? null,
      paidAt: payment.paidAt,
      failedAt: payment.failedAt,
      refundedAt: payment.refundedAt,
      failureReason: payment.failureReason,
      refundedAmount: payment.refundedAmount,
    };
    const before = byExt.get(payment.externalId);
    if (before) {
      await tx.payment.update({ where: { id: before.id }, data });
      result.payments.updated++;
      if (before.status !== payment.status) events.push({ payment, from: before.status });
    } else {
      await tx.payment.create({
        data: { ...data, orderId, externalSource: SOURCE, externalId: payment.externalId, createdAt: payment.paidAt ?? payment.failedAt ?? mapped.createdAt },
      });
      result.payments.created++;
      events.push({ payment, from: null });
    }
  }

  // A placeholder payment (e.g. pending COD) is replaced once Shopify reports a real transaction.
  const wanted = new Set(mapped.payments.map((p) => p.externalId));
  const stale = current.filter((p) => !p.externalId || !wanted.has(p.externalId));
  if (stale.length > 0) {
    await tx.payment.deleteMany({ where: { id: { in: stale.map((p) => p.id) }, externalSource: SOURCE } });
    result.payments.deleted += stale.length;
  }
  return events;
}

async function syncShipments(
  tx: Db,
  orderId: string,
  mapped: MappedOrder,
  current: { id: string; externalId: string | null }[],
  result: OrderResult,
): Promise<void> {
  const byExt = new Map(current.map((s) => [s.externalId, s]));

  for (const fulfillment of mapped.fulfillments) {
    const data = {
      status: fulfillment.status,
      courier: fulfillment.courier?.slice(0, 150) ?? null,
      trackingNumber: fulfillment.trackingNumber?.slice(0, 150) ?? null,
      trackingUrl: fulfillment.trackingUrl,
      shippedAt: fulfillment.shippedAt,
      deliveredAt: fulfillment.deliveredAt,
    };
    const before = byExt.get(fulfillment.externalId);
    if (before) {
      await tx.shipment.update({ where: { id: before.id }, data });
      result.shipments.updated++;
    } else {
      await tx.shipment.create({ data: { ...data, orderId, externalSource: SOURCE, externalId: fulfillment.externalId } });
      result.shipments.created++;
    }
  }

  // A fulfilment that Shopify has since cancelled never became a real shipment, so any row
  // previously synced for it is removed (mirrors how a stale placeholder payment is removed).
  const wanted = new Set(mapped.fulfillments.map((f) => f.externalId));
  const stale = current.filter((s) => !s.externalId || !wanted.has(s.externalId));
  if (stale.length > 0) {
    await tx.shipment.deleteMany({ where: { id: { in: stale.map((s) => s.id) }, externalSource: SOURCE } });
    result.shipments.deleted += stale.length;
  }
}

// Timeline entries for Customer 360 and the order's status history. Written only when something actually
// changed, so re-running a sync never adds duplicates.
async function recordActivity(
  tx: Db,
  orderId: string,
  leadId: string,
  mapped: MappedOrder,
  previousStatus: OrderStatus | null,
  paymentEvents: PaymentEvent[],
): Promise<void> {
  const base = { leadId, referenceType: ORDER_REFERENCE_TYPE, referenceId: orderId };
  const rows: Prisma.ActivityCreateManyInput[] = [];

  if (previousStatus === null) {
    rows.push({ ...base, type: ActivityType.ORDER_CREATED, title: `Shopify order ${mapped.externalNumber} placed`, createdAt: mapped.createdAt });
    if (mapped.confirmedAt) rows.push({ ...base, type: ActivityType.ORDER_CONFIRMED, title: `Order ${mapped.externalNumber} confirmed`, createdAt: mapped.confirmedAt });
  } else if (previousStatus !== mapped.status) {
    rows.push({
      ...base,
      type: ActivityType.STATUS_CHANGE,
      title: `Order ${mapped.externalNumber} status changed`,
      description: `${previousStatus} -> ${mapped.status}`,
      createdAt: mapped.externalUpdatedAt,
    });
  }

  for (const { payment, from } of paymentEvents) {
    if (!PAYMENT_EVENTS.has(payment.status)) continue;
    rows.push({
      ...base,
      type: ActivityType.PAYMENT,
      title: `Payment ${payment.status.toLowerCase().replace("_", " ")}${payment.provider ? ` (${payment.provider})` : ""}`,
      description: from ? `${from} -> ${payment.status}` : null,
      createdAt: payment.refundedAt ?? payment.paidAt ?? payment.failedAt ?? mapped.externalUpdatedAt,
    });
  }

  if (rows.length > 0) await tx.activity.createMany({ data: rows });
}
