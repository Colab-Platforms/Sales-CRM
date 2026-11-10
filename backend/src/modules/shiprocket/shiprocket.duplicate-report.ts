// Duplicate-resolution report: for every CRM order that has more than one live Shiprocket order, compares the two (or more) side by side and recommends what a PERSON should do.
//
// STRICTLY READ-ONLY: it SELECTs from the CRM database and sends only Shiprocket search requests (GET /orders?search=...). It cancels, deletes, creates, updates and re-registers nothing, changes no AWB or
// tracking, and never touches Shopify. "SAFE_TO_CANCEL" is a recommendation for a person to carry out in Shiprocket - this code has no way to do it.
//
// Reading the two sides of a pair
//   CRM_RECORDED   the shipment the CRM itself holds for the order (it receives the tracking webhooks and the AWB the CRM assigned).
//   SHIPROCKET_ONLY  a live Shiprocket order the CRM does not hold (typically the one Shiprocket's Shopify channel imported).
// The CRM-recorded side is NOT assumed to be the one to cancel: the side that carries the AWB / tracking is the one to keep.
//
// Classification of a pair (the first rule that applies):
//   NEEDS_MANUAL_REVIEW  a Shiprocket id is missing, a status is not understood (RTO, undelivered, lost, cancellation...), or both sides are delivered.
//   DELIVERED            one side is delivered. Nothing to cancel on that one; a still-idle twin is named for manual cancellation.
//   ACTIVE_SHIPMENT      both sides have an AWB / are moving: two real parcels. Nothing is ever recommended for cancellation.
//   SAFE_TO_CANCEL       exactly one side is idle (NEW / READY TO SHIP and NO AWB) and the other carries the AWB / tracking AND is confirmed as the intended shipment
//                        (its amount equals the CRM order total, and it is the CRM-recorded shipment or carries the CRM / Shopify reference).
//   NEEDS_MANUAL_REVIEW  anything else - notably two idle orders: neither carries tracking, so nothing says which one is intended.
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";
import { bareShopifyName } from "./shiprocket.channel-ref.js";
import { isRemoteCancelled, type RemoteLookup } from "./shiprocket.duplicates.js";

export type Classification = "SAFE_TO_CANCEL" | "ACTIVE_SHIPMENT" | "DELIVERED" | "NEEDS_MANUAL_REVIEW";
export type Phase = "DELIVERED" | "IN_MOTION" | "HAS_AWB" | "IDLE" | "UNKNOWN";

export interface Side {
  origin: "CRM_RECORDED" | "SHIPROCKET_ONLY";
  shiprocketOrderId: string | null;
  shiprocketShipmentId: string | null;
  reference: string | null;
  status: string | null;
  awb: string | null;
  courier: string | null;
  createdAt: string | null;
  paymentMethod: string | null;
  totalCents: number | null;
  phase: Phase;
  crm: { shipmentRowId: string; crmStatus: string; providerStatus: string | null; trackingUrl: string | null; pickupScheduledAt: string | null; shippedAt: string | null; deliveredAt: string | null } | null;
}

export interface PairRow {
  classification: Classification;
  crmOrderNumber: string;
  crmOrderId: string;
  shopifyOrderNumber: string | null;
  shopifyOrderId: string | null;
  orderTotalCents: number | null;
  /** Which side to keep, when the data supports a choice. */
  keep: "A" | "B" | null;
  /** A = the CRM-recorded shipment (or the first live one); B = the other Shiprocket order. */
  a: Side;
  b: Side;
  recommendedAction: string;
  notes: string[];
}

export interface DuplicateReport {
  checkedOrders: number;
  pairs: PairRow[];
  totals: Record<Classification, number>;
  lookupErrors: { crmOrderNumber: string; error: string }[];
}

interface OrderRow {
  id: string;
  orderNumber: string;
  externalId: string | null;
  externalNumber: string | null;
  totalAmount: { toString(): string } | null;
  shipments: { id: string; status: string; externalId: string | null; providerOrderId: string | null; channelOrderId: string | null; trackingNumber: string | null; courier: string | null; trackingUrl: string | null; providerStatus: string | null; pickupScheduledAt: Date | null; shippedAt: Date | null; deliveredAt: Date | null; createdAt: Date }[];
}
export interface DuplicateReportDb { order: { findMany(args: unknown): Promise<OrderRow[]> } }

const DEAD = new Set<string>([ShipmentStatus.CANCELLED, ShipmentStatus.RETURNED]);
const norm = (t: string | null | undefined) => (t ?? "").toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const IN_MOTION = /PICKED UP|IN TRANSIT|OUT FOR DELIVERY|SHIPPED|REACHED|PICKUP SCHEDULED|PICKUP GENERATED|OUT FOR PICKUP|PICKUP QUEUED|PICKUP RESCHEDULED/;
const NOT_UNDERSTOOD = /RTO|RETURN|UNDELIVERED|LOST|DAMAGED|CANCEL|NDR|MISROUTE|REJECT|HOLD/;
const cents = (v: { toString(): string } | null) => (v == null ? null : Math.round(Number(v.toString()) * 100));

/** Pure. Where a parcel stands, from Shiprocket's own status wording, its AWB and (for the CRM-recorded side) the CRM's delivery timestamp. */
export function phaseOf(side: { status: string | null; awb: string | null; deliveredAt?: string | null; providerStatus?: string | null }): Phase {
  const text = norm(side.status ?? side.providerStatus);
  if (text === "DELIVERED" || (side.deliveredAt && !NOT_UNDERSTOOD.test(text))) return "DELIVERED";
  if (!text && !side.awb) return "UNKNOWN";
  if (NOT_UNDERSTOOD.test(text)) return "UNKNOWN";
  if (IN_MOTION.test(text)) return "IN_MOTION";
  if (side.awb) return "HAS_AWB";
  return text === "NEW" || text === "READY TO SHIP" ? "IDLE" : "UNKNOWN";
}
const active = (p: Phase) => p === "IN_MOTION" || p === "HAS_AWB";
const describe = (s: Side) => `${s.shiprocketOrderId ?? "?"} (${s.reference ?? "?"}; ${s.status ?? "status ?"}; AWB ${s.awb ?? "none"})`;

/** Pure. Classifies one pair and words the recommendation. */
export function classifyPair(order: { orderNumber: string; shopifyName: string | null; totalCents: number | null }, a: Side, b: Side): Pick<PairRow, "classification" | "keep" | "recommendedAction" | "notes"> {
  const notes: string[] = [];
  const mismatched = [a, b].filter((s) => order.totalCents != null && s.totalCents != null && s.totalCents !== order.totalCents);
  for (const s of mismatched) notes.push(`${s.shiprocketOrderId} carries ${(s.totalCents! / 100).toFixed(2)} but the CRM order total is ${(order.totalCents! / 100).toFixed(2)} (amounts were not changed)`);
  const review = (why: string, keep: "A" | "B" | null = null): ReturnType<typeof classifyPair> => ({ classification: "NEEDS_MANUAL_REVIEW", keep, recommendedAction: `Review by hand: ${why}. Do not cancel until a person has checked both orders in Shiprocket.`, notes });

  if (!a.shiprocketOrderId || !b.shiprocketOrderId) return review("a Shiprocket order id is missing");
  if (a.phase === "UNKNOWN" || b.phase === "UNKNOWN") return review(`a status is missing or not one this report acts on (A: ${a.status ?? "-"}, B: ${b.status ?? "-"})`);

  if (a.phase === "DELIVERED" && b.phase === "DELIVERED") return review("both orders show as delivered");
  if (a.phase === "DELIVERED" || b.phase === "DELIVERED") {
    const keep = a.phase === "DELIVERED" ? "A" : "B";
    const other = keep === "A" ? b : a;
    notes.push(other.phase === "IDLE" ? `The other order ${other.shiprocketOrderId} is still idle (no AWB) - it can be cancelled in Shiprocket by a person` : `The other order ${other.shiprocketOrderId} is also ${other.phase === "DELIVERED" ? "delivered" : "tracked"}`);
    return { classification: "DELIVERED", keep, recommendedAction: `Already delivered (${describe(keep === "A" ? a : b)}). Keep it. ${other.phase === "IDLE" ? `Manually cancel the idle duplicate ${other.shiprocketOrderId} in Shiprocket.` : "Nothing to cancel."}`, notes };
  }
  if (active(a.phase) && active(b.phase)) {
    notes.push("Two parcels may be on their way - confirm with the courier before anything is done");
    return { classification: "ACTIVE_SHIPMENT", keep: null, recommendedAction: `Both orders have an AWB / are moving (A ${describe(a)}; B ${describe(b)}). Do NOT cancel either. Check with the courier whether one parcel can be stopped.`, notes };
  }
  if (a.phase === "IDLE" && b.phase === "IDLE") return review("both orders are idle (no AWB): nothing says which is the intended one. Suggested keep: the CRM-recorded order, since the CRM tracks it", a.origin === "CRM_RECORDED" ? "A" : null);

  // exactly one side carries tracking, the other is idle
  const keep: "A" | "B" = active(a.phase) ? "A" : "B";
  const kept = keep === "A" ? a : b;
  const idle = keep === "A" ? b : a;
  const refOk = kept.origin === "CRM_RECORDED" || [order.orderNumber, order.shopifyName ? bareShopifyName(order.shopifyName) : null].some((r) => r && kept.reference && kept.reference.toLowerCase() === r.toLowerCase());
  const amountOk = order.totalCents != null && kept.totalCents != null && kept.totalCents === order.totalCents;
  if (!refOk || !amountOk) return review(`the tracked order ${kept.shiprocketOrderId} is not confirmed as the intended one (${!amountOk ? "its amount does not match the CRM order total" : "it is not the CRM-recorded shipment and carries neither the CRM nor the Shopify reference"})`, keep);
  if (idle.origin === "CRM_RECORDED") notes.push("The idle order is the CRM-recorded one: after cancelling it, the CRM will not hold the tracked shipment - re-run the reconciliation so the CRM adopts it");
  return { classification: "SAFE_TO_CANCEL", keep, recommendedAction: `Keep ${kept.shiprocketOrderId} (AWB ${kept.awb ?? "-"}, ${kept.status ?? "-"}). A person may cancel ${idle.shiprocketOrderId} (${idle.status ?? "-"}, no AWB) in Shiprocket. Nothing was cancelled.`, notes };
}

export interface BuildOptions { lookup: RemoteLookup; limit?: number; since?: Date; concurrency?: number }

export async function buildDuplicateReport(db: DuplicateReportDb, opts: BuildOptions): Promise<DuplicateReport> {
  const orders = await db.order.findMany({
    where: { source: "SALESPERSON", externalId: { not: null }, shipments: { some: { externalSource: "SHIPROCKET", status: { notIn: [...DEAD] } } }, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    orderBy: { createdAt: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
    select: { id: true, orderNumber: true, externalId: true, externalNumber: true, totalAmount: true, shipments: { where: { externalSource: "SHIPROCKET", status: { notIn: [...DEAD] } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, externalId: true, providerOrderId: true, channelOrderId: true, trackingNumber: true, courier: true, trackingUrl: true, providerStatus: true, pickupScheduledAt: true, shippedAt: true, deliveredAt: true, createdAt: true } } },
  });

  const pairs: PairRow[] = [];
  const lookupErrors: DuplicateReport["lookupErrors"] = [];
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  const examine = async (o: OrderRow): Promise<void> => {
    const ids = new Set<string>([o.orderNumber, ...(o.externalNumber ? [bareShopifyName(o.externalNumber)] : []), ...o.shipments.map((s) => s.channelOrderId ?? "")].filter(Boolean));
    const remote = new Map<string, ShiprocketOrderLookup>();
    try {
      for (const id of ids) for (const r of await opts.lookup(id)) if (r.shiprocketOrderId && !isRemoteCancelled(r.status)) remote.set(r.shiprocketOrderId, r);
    } catch (error) {
      lookupErrors.push({ crmOrderNumber: o.orderNumber, error: error instanceof Error ? error.message.slice(0, 200) : "lookup failed" });
      return;
    }
    const sides: Side[] = [];
    for (const s of o.shipments) {
      const r = s.providerOrderId ? remote.get(s.providerOrderId) : undefined;
      const status = r?.status ?? s.providerStatus ?? null;
      const awb = r?.awb ?? s.trackingNumber ?? null;
      const crm = { shipmentRowId: s.id, crmStatus: s.status, providerStatus: s.providerStatus, trackingUrl: s.trackingUrl, pickupScheduledAt: iso(s.pickupScheduledAt), shippedAt: iso(s.shippedAt), deliveredAt: iso(s.deliveredAt) };
      sides.push({ origin: "CRM_RECORDED", shiprocketOrderId: s.providerOrderId, shiprocketShipmentId: s.externalId?.startsWith("pending:") ? null : (s.externalId ?? r?.shiprocketShipmentId ?? null), reference: s.channelOrderId, status, awb, courier: r?.courier ?? s.courier ?? null, createdAt: r?.createdAt ?? iso(s.createdAt), paymentMethod: r?.paymentMethod ?? null, totalCents: r?.totalCents ?? null, phase: phaseOf({ status, awb, deliveredAt: crm.deliveredAt }), crm });
    }
    const known = new Set(sides.map((s) => s.shiprocketOrderId));
    for (const r of remote.values()) {
      if (known.has(r.shiprocketOrderId)) continue;
      sides.push({ origin: "SHIPROCKET_ONLY", shiprocketOrderId: r.shiprocketOrderId, shiprocketShipmentId: r.shiprocketShipmentId ?? null, reference: r.channelOrderId, status: r.status, awb: r.awb, courier: r.courier, createdAt: r.createdAt ?? null, paymentMethod: r.paymentMethod, totalCents: r.totalCents, phase: phaseOf({ status: r.status, awb: r.awb }), crm: null });
    }
    if (sides.length < 2) return; // one live Shiprocket order: not a duplicate
    const [primary, ...others] = sides;
    for (const other of others) {
      const c = classifyPair({ orderNumber: o.orderNumber, shopifyName: o.externalNumber, totalCents: cents(o.totalAmount) }, primary!, other);
      pairs.push({ ...c, crmOrderNumber: o.orderNumber, crmOrderId: o.id, shopifyOrderNumber: o.externalNumber, shopifyOrderId: o.externalId, orderTotalCents: cents(o.totalAmount), a: primary!, b: other });
    }
  };

  const width = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { for (;;) { const i = next++; if (i >= orders.length) return; await examine(orders[i]!); } }));

  pairs.sort((x, y) => x.classification.localeCompare(y.classification) || x.crmOrderNumber.localeCompare(y.crmOrderNumber));
  const totals: Record<Classification, number> = { SAFE_TO_CANCEL: 0, ACTIVE_SHIPMENT: 0, DELIVERED: 0, NEEDS_MANUAL_REVIEW: 0 };
  for (const p of pairs) totals[p.classification]++;
  return { checkedOrders: orders.length, pairs, totals, lookupErrors };
}

const CSV_HEAD = ["classification", "recommended_action", "keep", "crm_order_id", "shopify_order_number", "shopify_order_id", "crm_order_total",
  ...["a", "b"].flatMap((p) => ["origin", "shiprocket_order_id", "shiprocket_shipment_id", "reference", "status", "phase", "awb", "courier", "created_at", "payment_method", "amount", "crm_status", "picked_up_at", "delivered_at"].map((c) => `${p}_${c}`)), "notes"];

export function pairToCells(p: PairRow): (string | number)[] {
  const side = (s: Side) => [s.origin, s.shiprocketOrderId ?? "", s.shiprocketShipmentId ?? "", s.reference ?? "", s.status ?? "", s.phase, s.awb ?? "", s.courier ?? "", s.createdAt ?? "", s.paymentMethod ?? "", s.totalCents == null ? "" : (s.totalCents / 100).toFixed(2), s.crm?.crmStatus ?? "", s.crm?.shippedAt ?? "", s.crm?.deliveredAt ?? ""];
  return [p.classification, p.recommendedAction, p.keep ?? "", p.crmOrderNumber, p.shopifyOrderNumber ?? "", p.shopifyOrderId ?? "", p.orderTotalCents == null ? "" : (p.orderTotalCents / 100).toFixed(2), ...side(p.a), ...side(p.b), p.notes.join(" | ")];
}
export const reportColumns = (): string[] => CSV_HEAD;

/** CSV (UTF-8 with BOM so Excel opens it correctly). Cells starting with = + - @ are prefixed with ' so a spreadsheet never runs them as formulas. */
export function toCsv(report: DuplicateReport): string {
  const cell = (v: string | number) => { let t = String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return "﻿" + [CSV_HEAD, ...report.pairs.map(pairToCells)].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
