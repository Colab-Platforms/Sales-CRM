// Duplicate protection for Shiprocket orders. READ-ONLY towards Shiprocket: it only ever searches (GET /orders?search=...); it never creates, updates or cancels anything.
//
// Why this exists: a CRM order can reach Shiprocket by two independent routes - the CRM's own submission (channel order id = the CRM order number, e.g. CRM-MW62HLOS-...) and, once the CRM
// has pushed the same sale to Shopify, the store's Shopify-Shiprocket channel, which imports the Shopify order (channel order id = the Shopify name, e.g. AWL110598). The CRM's per-order lock
// stops two CRM submissions; it cannot see the other route. So before the CRM creates a Shiprocket order it asks Shiprocket whether one already exists for the same sale, and a separate
// report lists the pairs that already exist so a person can decide which one to keep.
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";

export type RemoteLookup = (channelOrderId: string) => Promise<ShiprocketOrderLookup[]>;

const CANCELLED_TEXT = /cancel/i;

/** Pure. A Shiprocket order text that means "no longer a live order". */
export function isRemoteCancelled(status: string | null | undefined): boolean {
  return CANCELLED_TEXT.test(status ?? "");
}

/** Pure. The distinct, non-empty channel order ids to search for one CRM order: the id the CRM sends and the Shopify name it is linked to (when it is). */
export function channelIdsFor(order: { orderNumber: string; externalNumber?: string | null }, extra: (string | null | undefined)[] = []): string[] {
  const ids = [order.orderNumber, order.externalNumber, ...extra].map((v) => (v ?? "").replace(/^#/, "").trim()).filter(Boolean);
  return [...new Set(ids)];
}

/**
 * The LIVE Shiprocket orders already present for these channel ids (a cancelled one does not count), minus the one the CRM itself holds (`ownProviderOrderId`). Searches run one after the
 * other; a failing search throws, so the caller decides whether to continue.
 */
export async function findLiveRemoteOrders(lookup: RemoteLookup, channelIds: string[], ownProviderOrderId?: string | null): Promise<ShiprocketOrderLookup[]> {
  const found = new Map<string, ShiprocketOrderLookup>();
  for (const id of channelIds) {
    for (const o of await lookup(id)) {
      if (!o.shiprocketOrderId || isRemoteCancelled(o.status)) continue;
      if (ownProviderOrderId && o.shiprocketOrderId === ownProviderOrderId) continue;
      found.set(o.shiprocketOrderId, o);
    }
  }
  return [...found.values()];
}

export function describeRemoteTwins(twins: ShiprocketOrderLookup[]): string {
  const list = twins.map((t) => `${t.shiprocketOrderId} (${t.channelOrderId}${t.status ? `, ${t.status}` : ""})`).join(", ");
  return `Shiprocket already has an order for this sale: ${list}. No second order was created. Check it in Shiprocket and use that one, or cancel it there first.`;
}

// ------------------------------------------------------------------ report of duplicates that already exist

export type DuplicateKind = "MULTIPLE_LIVE_SHIPMENTS" | "SHOPIFY_IMPORT_TWIN";

export interface DuplicateFinding {
  kind: DuplicateKind;
  orderId: string;
  orderNumber: string;
  shopifyName: string | null;
  customer: string;
  crmShiprocketOrderIds: string[];
  /** Orders found at Shiprocket besides the CRM's own (SHOPIFY_IMPORT_TWIN only). */
  otherShiprocketOrders: { shiprocketOrderId: string; channelOrderId: string; status: string | null; totalCents: number | null; awb: string | null }[];
  note: string;
}

export interface LiveShipmentRow {
  id: string;
  status: string;
  providerOrderId: string | null;
  externalId: string | null;
  order: { id: string; orderNumber: string; externalNumber: string | null; totalAmount?: unknown; lead: { firstName: string | null; lastName: string | null; mobile: string | null } | null };
}

export interface DuplicateScanDb {
  shipment: { findMany(args: unknown): Promise<LiveShipmentRow[]> };
}

const DEAD = new Set<string>([ShipmentStatus.CANCELLED, ShipmentStatus.RETURNED]);

/**
 * Lists every CRM order that already has more than one live Shiprocket order, for MANUAL review. Nothing is cancelled, deleted or changed.
 *  - MULTIPLE_LIVE_SHIPMENTS: the CRM database itself holds two live Shiprocket shipments for one order.
 *  - SHOPIFY_IMPORT_TWIN: the CRM's own Shiprocket order exists and Shiprocket also holds the order it imported from the linked Shopify order.
 */
export async function scanShiprocketDuplicates(db: DuplicateScanDb, lookup: RemoteLookup, opts: { since?: Date; limit?: number } = {}): Promise<DuplicateFinding[]> {
  const rows = await db.shipment.findMany({
    where: { externalSource: "SHIPROCKET", status: { notIn: [...DEAD] }, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    orderBy: { createdAt: "desc" },
    ...(opts.limit ? { take: opts.limit } : {}),
    select: { id: true, status: true, providerOrderId: true, externalId: true, order: { select: { id: true, orderNumber: true, externalNumber: true, lead: { select: { firstName: true, lastName: true, mobile: true } } } } },
  });
  const byOrder = new Map<string, LiveShipmentRow[]>();
  for (const r of rows) byOrder.set(r.order.id, [...(byOrder.get(r.order.id) ?? []), r]);

  const out: DuplicateFinding[] = [];
  for (const group of byOrder.values()) {
    const order = group[0]!.order;
    const customer = [order.lead?.firstName, order.lead?.lastName].filter(Boolean).join(" ") || order.lead?.mobile || "";
    const own = group.map((g) => g.providerOrderId).filter((v): v is string => Boolean(v));
    const base = { orderId: order.id, orderNumber: order.orderNumber, shopifyName: order.externalNumber, customer, crmShiprocketOrderIds: own };
    if (group.length > 1) out.push({ ...base, kind: "MULTIPLE_LIVE_SHIPMENTS", otherShiprocketOrders: [], note: `${group.length} live Shiprocket shipments are recorded for this one CRM order.` });
    if (!order.externalNumber) continue;
    const twins = (await findLiveRemoteOrders(lookup, channelIdsFor({ orderNumber: "", externalNumber: order.externalNumber }))).filter((t) => !own.includes(t.shiprocketOrderId));
    if (twins.length > 0) {
      out.push({
        ...base,
        kind: "SHOPIFY_IMPORT_TWIN",
        otherShiprocketOrders: twins.map((t) => ({ shiprocketOrderId: t.shiprocketOrderId, channelOrderId: t.channelOrderId, status: t.status, totalCents: t.totalCents, awb: t.awb })),
        note: "The CRM created its own Shiprocket order and Shiprocket also imported the linked Shopify order. Keep one; ship only that one.",
      });
    }
  }
  return out;
}
