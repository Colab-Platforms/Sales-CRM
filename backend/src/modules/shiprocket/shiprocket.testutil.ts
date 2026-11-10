// Test helpers shared by the Shiprocket tests that run without a database: a CRM-created order as createManualOrder stores it, an in-memory stand-in for the few order/shipment
// operations the Shiprocket code uses, and a fake Shiprocket that records what it was sent. Nothing here touches a database, Shopify or Shiprocket.
import { Role } from "../../../generated/prisma/enums.js";
import { loadShiprocketConfig } from "./shiprocket.config.js";
import type { ShiprocketApi } from "./shiprocket.shipments.service.js";
import type { CreateOrderRequest, ShiprocketOrderLookup } from "./shiprocket.client.js";

export const CONFIG = loadShiprocketConfig({ SHIPROCKET_ENABLED: "true", SHIPROCKET_EMAIL: "api@example.com", SHIPROCKET_PASSWORD: "not-real", SHIPROCKET_PICKUP_LOCATION: "warehouse" });
export const ADMIN = { id: "admin-1", username: "admin", role: Role.ADMIN };
export const DIMS = { weight: 0.5, length: 10, breadth: 10, height: 5 };
export const ENV = { SHIPROCKET_ENABLED: "true" };

// The order exactly as createManualOrder stores a telecaller's COD order while the switch is OFF: source SALESPERSON, no Shopify link at all.
export const ORDER = {
  id: "order-1",
  orderNumber: "CRM-TEST-0001",
  status: "CONFIRMED",
  source: "SALESPERSON",
  externalId: null as string | null,
  externalNumber: null as string | null,
  metadata: { paymentMode: "COD", createdVia: "WHATSAPP_INBOX", shopifySyncDecision: { enabled: false, decidedAt: "2026-11-04T00:00:00.000Z" } },
  placedAt: new Date("2026-11-04T06:30:00Z"),
  createdAt: new Date("2026-11-04T06:30:00Z"),
  currency: "INR",
  totalAmount: "1249.00",
  discountAmount: "0.00",
  shippingAmount: "50.00",
  shippingAddress: { name: "Priya Shah", address1: "12 MG Road", city: "Pune", province: "Maharashtra", zip: "411001", country: "India", phone: "9876500000" },
  lead: { id: "lead-1", firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "919876500000", email: "priya@example.com" },
  items: [{ productNameSnapshot: "Herbal Masala", variantNameSnapshot: "Paan / 120", skuSnapshot: "AW-HM-PN-120", quantity: 1, unitPrice: "1199.00", discountAmount: "0.00", taxAmount: "0.00", variant: null as { weightKg: string | null; lengthCm: string | null; widthCm: string | null; heightCm: string | null } | null, product: { weightKg: "0.25" as string | null, lengthCm: "10" as string | null, widthCm: "8" as string | null, heightCm: "5" as string | null } }],
  payments: [{ status: "PENDING", method: "COD", amount: "1249.00", refundedAmount: null }],
};

export type Row = Record<string, unknown> & { id: string };

/** The few table operations the Shiprocket code uses. */
/** `order` is copied: each call has its own order whose metadata the fake keeps up to date (the Shiprocket sync record is merged into it, as the real UPDATE does). */
export function fakeDb(base: typeof ORDER = ORDER) {
  const order = { ...base, metadata: { ...base.metadata } as Record<string, unknown>, parcelWeightKg: null as string | null };
  const shipments: Row[] = [];
  const activities: Record<string, unknown>[] = [];
  const withOrder = (s: Row) => ({ ...s, order: { id: ORDER.id, leadId: ORDER.lead.id, orderNumber: ORDER.orderNumber, externalNumber: ORDER.externalNumber } });
  const match = (s: Row, where: Record<string, unknown>): boolean => {
    if (where.id && s.id !== where.id) return false;
    if (where.externalSource && s.externalSource !== where.externalSource) return false;
    if (Array.isArray(where.OR) && !(where.OR as Record<string, unknown>[]).some((c) => Object.entries(c).every(([k, v]) => s[k === "trackingNumber" ? "trackingNumber" : k] === v))) return false;
    return true;
  };
  const shiprocketRows = () => shipments.filter((s) => s.externalSource === "SHIPROCKET").map((s) => ({ id: s.id, status: s.status, metadata: s.metadata, externalId: s.externalId, createdAt: new Date() }));
  const tx = {
    $executeRaw: async (sql: TemplateStringsArray, ...v: unknown[]) => {
      if (!sql.join("?").includes("shiprocketSync")) return 1; // e.g. the advisory lock
      // mergeShiprocketSync(patch): metadata.shiprocketSync = existing || patch
      const meta = order.metadata as Record<string, unknown>;
      meta.shiprocketSync = { ...((meta.shiprocketSync as object | undefined) ?? {}), ...JSON.parse(String(v[0])) };
      return 1;
    },
    order: {
      findFirst: async () => ({ ...order, shipments: shiprocketRows() }),
      findUnique: async () => ({ ...order, shipments: shiprocketRows() }),
      update: async () => order,
    },
    shipment: {
      create: async ({ data }: { data: Row }) => { shipments.push({ ...data }); return data; },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const s = shipments.find((x) => match(x, where)); return s ? withOrder(s) : null; },
      findUnique: async ({ where }: { where: { id: string } }) => { const s = shipments.find((x) => x.id === where.id); return s ? withOrder(s) : null; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withOrder(shipments.find((x) => x.id === where.id)!),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { Object.assign(shipments.find((x) => x.id === where.id)!, data); },
    },
    activity: { create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); }, createMany: async ({ data }: { data: Record<string, unknown>[] }) => { activities.push(...data); } },
  };
  return { tx, order, runner: { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) }, shipments, activities };
}

/** `existing`: orders Shiprocket already holds (e.g. one imported from Shopify); a search returns those whose channel id matches. `searchFails`: every search throws. */
export function fakeShiprocket(opts: { existing?: ShiprocketOrderLookup[]; searchFails?: boolean } = {}) {
  const sent: CreateOrderRequest[] = [];
  const searches: string[] = [];
  const api: ShiprocketApi = {
    findOrdersByChannelId: async (id) => {
      searches.push(id);
      if (opts.searchFails) throw new Error("Shiprocket search unavailable");
      return (opts.existing ?? []).filter((o) => o.channelOrderId.toLowerCase() === id.replace(/^#/, "").toLowerCase());
    },
    createOrder: async (request) => { sent.push(request); return { orderId: "SR-ORD-555", shipmentId: "SR-SHIP-777", awb: null, courierName: null, courierCompanyId: null } as never; },
    getCouriers: async () => [],
    assignAwb: async () => ({ awb: "AWB-TEST-123", courierName: "Test Courier", courierCompanyId: 9 }),
    generatePickup: async () => ({ scheduledDate: null, tokenNumber: null }),
    generateLabel: async () => "https://example.test/label.pdf",
    track: async () => null,
  };
  return { api, sent, searches };
}

