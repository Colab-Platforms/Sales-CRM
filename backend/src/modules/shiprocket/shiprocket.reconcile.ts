// Reconciles EXISTING Shiprocket orders with their Shopify orders: orders the CRM registered under its own number (CRM-...) before the Shopify reference became the rule (see shiprocket.channel-ref.ts).
//
// What it does, and what it deliberately does not:
//  - DRY RUN by default: it only reads. `apply` writes ONE kind of change: the mapping (CRM order number, Shopify order id + number, Shiprocket order id, original Shiprocket reference) into
//    Order.metadata.shiprocketSync and Shipment.metadata.shiprocket - an additive JSON merge. Status, AWB, courier, tracking URL, payment, history and Shipment.channelOrderId are NEVER touched
//    (channelOrderId must keep equal to what Shiprocket echoes in its tracking webhooks, which for these orders is still the CRM reference).
//  - It never creates, updates, cancels or deletes anything in Shiprocket or Shopify. Renaming the reference of an existing Shiprocket order is NOT done: Shiprocket's update call identifies the order BY that
//    reference and offers no verified way to change it, so those orders are reported (REFERENCE_UNCHANGED) for a person to handle. The shipment is kept as it is.
//  - A match is never guessed. An order is matched only when the shipment row belongs to the CRM order (its own foreign key), the Shiprocket reference stored on it is EXACTLY the CRM order number or EXACTLY the
//    Shopify name, and Shiprocket's order id is recorded. Optionally (`lookup`) Shiprocket is asked read-only and must confirm the same Shiprocket order id (and AWB, when both have one). Anything else is UNMATCHED.
//  - Duplicates (several live shipments for one order, or - with `lookup` - a second live Shiprocket order under the Shopify name) are listed only.
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import { asRecord } from "../integrations/integrations.common.js";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";
import { bareShopifyName } from "./shiprocket.channel-ref.js";
import { findLiveRemoteOrders, type RemoteLookup } from "./shiprocket.duplicates.js";
import { mergeShiprocketSync, readShiprocketSync } from "./shiprocket.sync-record.js";

export type ReconcileState = "ALREADY_CORRECT" | "NEEDS_MAPPING" | "DUPLICATE" | "UNMATCHED";

export interface ReconcileRow {
  state: ReconcileState;
  orderId: string;
  crmOrderNumber: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  shiprocketOrderId: string | null;
  shipmentId: string | null;
  awb: string | null;
  /** The reference Shiprocket currently shows for this order. */
  shiprocketReference: string | null;
  /** The Shiprocket reference is still the CRM number: Shiprocket needs a manual rename (the CRM cannot change it). */
  referenceUnchanged: boolean;
  reason: string;
  applied?: boolean;
}

export interface ReconcileReport {
  dryRun: boolean;
  checked: number;
  matched: number;
  alreadyCorrect: number;
  needsMapping: number;
  referenceCorrectionNeeded: number;
  duplicates: number;
  unmatched: number;
  applied: number;
  rows: ReconcileRow[];
}

const DEAD = new Set<string>([ShipmentStatus.CANCELLED, ShipmentStatus.RETURNED]);
const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a) && Boolean(b) && bareShopifyName(a!).toLowerCase() === bareShopifyName(b!).toLowerCase();

interface OrderRow {
  id: string;
  orderNumber: string;
  externalId: string | null;
  externalNumber: string | null;
  metadata: unknown;
  shipments: { id: string; status: string; externalId: string | null; providerOrderId: string | null; channelOrderId: string | null; trackingNumber: string | null; metadata: unknown }[];
}

export interface ReconcileDb {
  order: { findMany(args: unknown): Promise<OrderRow[]> };
  $executeRaw(sql: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface ReconcileOptions {
  apply?: boolean;
  limit?: number;
  since?: Date;
  /** Read-only Shiprocket search by channel order id. Without it the check uses the CRM's own records only. */
  lookup?: RemoteLookup;
  now?: () => Date;
}

export async function reconcileShiprocketOrders(db: ReconcileDb, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const now = (opts.now ?? (() => new Date()))();
  const orders = await db.order.findMany({
    // CRM-created orders only (a Shopify-originated order is never touched) that are linked to Shopify and have a Shiprocket shipment the CRM created.
    where: { source: "SALESPERSON", externalId: { not: null }, shipments: { some: { externalSource: "SHIPROCKET", status: { notIn: [...DEAD] } } }, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    orderBy: { createdAt: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
    select: { id: true, orderNumber: true, externalId: true, externalNumber: true, metadata: true, shipments: { where: { externalSource: "SHIPROCKET", status: { notIn: [...DEAD] } }, select: { id: true, status: true, externalId: true, providerOrderId: true, channelOrderId: true, trackingNumber: true, metadata: true } } },
  });

  const rows: ReconcileRow[] = [];
  for (const o of orders) {
    const s = o.shipments[0]!;
    const base = { orderId: o.id, crmOrderNumber: o.orderNumber, shopifyOrderId: o.externalId, shopifyOrderName: o.externalNumber, shiprocketOrderId: s.providerOrderId, shipmentId: s.externalId, awb: s.trackingNumber, shiprocketReference: s.channelOrderId, referenceUnchanged: false };
    const row = (state: ReconcileState, reason: string, extra: Partial<ReconcileRow> = {}): ReconcileRow => ({ ...base, state, reason, ...extra });

    if (o.shipments.length > 1) { rows.push(row("DUPLICATE", `${o.shipments.length} live Shiprocket shipments are recorded for this one CRM order (${o.shipments.map((x) => x.providerOrderId ?? x.externalId).join(", ")}). Review by hand; nothing was changed.`)); continue; }

    // ---- a confident match, or no match
    if (!o.externalNumber) { rows.push(row("UNMATCHED", "The CRM order has a Shopify id but no Shopify order number")); continue; }
    if (!s.providerOrderId || !s.externalId || s.externalId.startsWith("pending:")) { rows.push(row("UNMATCHED", "The shipment has no confirmed Shiprocket order / shipment id (a submission that never got an answer)")); continue; }
    const isCrmRef = s.channelOrderId === o.orderNumber;
    const isShopifyRef = same(s.channelOrderId, o.externalNumber);
    if (!isCrmRef && !isShopifyRef) { rows.push(row("UNMATCHED", `The Shiprocket reference "${s.channelOrderId ?? "-"}" is neither this CRM order number nor its Shopify number - not matched on similarity`)); continue; }

    let remote: ShiprocketOrderLookup | undefined;
    if (opts.lookup) {
      let found: ShiprocketOrderLookup[];
      try { found = await opts.lookup(s.channelOrderId!); } catch (error) { rows.push(row("UNMATCHED", `Shiprocket could not be asked: ${error instanceof Error ? error.message : "error"}`)); continue; }
      remote = found.find((r) => r.shiprocketOrderId === s.providerOrderId);
      if (!remote) { rows.push(row("UNMATCHED", "Shiprocket does not confirm an order with this id under this reference")); continue; }
      if (remote.awb && s.trackingNumber && remote.awb !== s.trackingNumber) { rows.push(row("UNMATCHED", "Shiprocket reports a different AWB than the CRM holds")); continue; }
      // a second live Shiprocket order for the same sale (e.g. the one the Shopify channel imported) is a duplicate: reported, never touched
      const twins = (await findLiveRemoteOrders(opts.lookup, [bareShopifyName(o.externalNumber), o.orderNumber], s.providerOrderId)).filter((t) => t.shiprocketOrderId !== s.providerOrderId);
      if (twins.length > 0) { rows.push(row("DUPLICATE", `Shiprocket also holds ${twins.map((t) => `${t.shiprocketOrderId} (${t.channelOrderId}${t.status ? `, ${t.status}` : ""}${t.awb ? `, AWB ${t.awb}` : ""})`).join("; ")} for this sale. Keep one; cancel the other in Shiprocket yourself. Nothing was changed.`)); continue; }
    }

    const rec = readShiprocketSync(o.metadata);
    const sm = asRecord(asRecord(s.metadata).shiprocket);
    const mapped = sm.shopifyOrderId === o.externalId && typeof sm.shopifyOrderName === "string" && rec?.shopifyOrderId === o.externalId && rec?.crmOrderNumber === o.orderNumber && rec?.shiprocketOrderId === s.providerOrderId;
    if (mapped) { rows.push(row("ALREADY_CORRECT", isShopifyRef ? "Shiprocket shows the Shopify order number and the CRM mapping is complete" : "The CRM mapping is complete; Shiprocket still shows the CRM reference (manual rename only)", { referenceUnchanged: isCrmRef })); continue; }

    const r = row("NEEDS_MAPPING", isCrmRef ? "Shiprocket shows the CRM reference. The CRM mapping is completed; the Shiprocket reference cannot be changed by the CRM and stays as it is." : "The CRM mapping is incomplete", { referenceUnchanged: isCrmRef });
    if (opts.apply) r.applied = await applyMapping(db, o, s, now);
    rows.push(r);
  }

  const count = (state: ReconcileState) => rows.filter((r) => r.state === state).length;
  return {
    dryRun: !opts.apply,
    checked: orders.length,
    matched: count("ALREADY_CORRECT") + count("NEEDS_MAPPING"),
    alreadyCorrect: count("ALREADY_CORRECT"),
    needsMapping: count("NEEDS_MAPPING"),
    referenceCorrectionNeeded: rows.filter((r) => r.referenceUnchanged).length,
    duplicates: count("DUPLICATE"),
    unmatched: count("UNMATCHED"),
    applied: rows.filter((r) => r.applied).length,
    rows,
  };
}

/** The only write: an additive JSON merge of the mapping. Guarded so it only lands on the exact shipment/order pair that was matched. Idempotent. */
async function applyMapping(db: ReconcileDb, o: OrderRow, s: OrderRow["shipments"][number], now: Date): Promise<boolean> {
  const mapping = JSON.stringify({ crmOrderNumber: o.orderNumber, shopifyOrderId: o.externalId, shopifyOrderName: o.externalNumber, shiprocketReference: s.channelOrderId, reconciledAt: now.toISOString() });
  const changed = await db.$executeRaw`UPDATE shipments SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('shiprocket', COALESCE(metadata->'shiprocket', '{}'::jsonb) || ${mapping}::jsonb) WHERE id = ${s.id}::uuid AND order_id = ${o.id}::uuid AND provider_order_id = ${s.providerOrderId}`;
  if (changed !== 1) return false;
  // An order that never had a sync record (created before it existed, or shipped by hand) gets one that simply states what is true: it is registered in Shiprocket, under the reference it already has.
  const fresh = readShiprocketSync(o.metadata) ? {} : { status: "SYNCED" as const, attempts: 0, channelOrderId: s.channelOrderId };
  await mergeShiprocketSync(db as never, o.id, { ...fresh, crmOrderNumber: o.orderNumber, shopifyOrderId: o.externalId, shopifyOrderName: o.externalNumber, shiprocketOrderId: s.providerOrderId });
  return true;
}

export function formatReconcileReport(r: ReconcileReport): string {
  const lines = [
    `${r.dryRun ? "DRY RUN - nothing was changed" : `APPLIED - ${r.applied} mapping(s) written (metadata only)`}`,
    `Total existing orders checked:        ${r.checked}`,
    `Successfully matched:                 ${r.matched}`,
    `  already correct:                    ${r.alreadyCorrect}`,
    `  needing the CRM mapping completed:  ${r.needsMapping}`,
    `Showing a CRM reference in Shiprocket: ${r.referenceCorrectionNeeded}  (manual rename in Shiprocket; the CRM cannot change it)`,
    `Duplicate Shiprocket orders:          ${r.duplicates}`,
    `Unmatched:                            ${r.unmatched}`,
    "",
  ];
  for (const x of r.rows.filter((row) => row.state !== "ALREADY_CORRECT")) lines.push(`${x.state.padEnd(13)} ${x.crmOrderNumber} | Shopify ${x.shopifyOrderName ?? "-"} | Shiprocket order ${x.shiprocketOrderId ?? "-"} (ref ${x.shiprocketReference ?? "-"}) | AWB ${x.awb ?? "-"} | ${x.reason}`);
  return lines.join("\n");
}
