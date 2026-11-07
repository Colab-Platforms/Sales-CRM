// "Shopify Sync for CRM-Created Orders": one Admin-controlled, database-backed switch (app_setting row) for orders created INSIDE the CRM
// (Telecaller / Manager / Admin, COD and prepaid). Default ON whenever it was never configured, or its table does not exist yet (so deploying before the migration changes nothing).
//
// The switch is read ONCE, when a CRM order is created, and the answer is stored on that order (Order.metadata.shopifySyncDecision). Every later Shopify push of that
// order - the COD push, the push after a verified prepaid payment, a manual or idempotent retry, the interrupted-request recovery - obeys the STORED decision,
// never the live switch, so flipping the switch never changes the lifecycle of an order that already exists. An order with no stored decision (created before
// this feature) keeps behaving exactly as it did. Orders that came FROM Shopify never carry a decision and never go through the push at all.
import type { Prisma } from "../../../generated/prisma/client.js";

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export const SHOPIFY_CRM_SYNC_KEY = "shopify.crmOrderSync";

export interface ShopifySyncSetting {
  enabled: boolean;
  /** When an Admin last changed it; null = never configured (default ON). */
  updatedAt: string | null;
  updatedById: string | null;
}

/** The decision stored on a CRM order at creation. */
export interface ShopifySyncDecision {
  enabled: boolean;
  decidedAt: string;
}

const DEFAULT_SETTING: ShopifySyncSetting = { enabled: true, updatedAt: null, updatedById: null };

export async function readShopifySyncSetting(db: Db): Promise<ShopifySyncSetting> {
  // to_regclass never raises: code deployed before the migration reads as "never configured" (OFF) instead of failing order creation.
  const exists = await db.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('app_setting')::text AS t`;
  if (!exists[0]?.t) return DEFAULT_SETTING;
  const rows = await db.$queryRaw<{ value: unknown; updatedAt: Date; updatedById: string | null }[]>`SELECT value, updated_at AS "updatedAt", updated_by_id AS "updatedById" FROM app_setting WHERE key = ${SHOPIFY_CRM_SYNC_KEY}`;
  const row = rows[0];
  if (!row) return DEFAULT_SETTING;
  // A saved value always wins; only a row that says nothing usable falls back to the default.
  const saved = typeof row.value === "object" && row.value !== null ? (row.value as { enabled?: unknown }).enabled : undefined;
  const enabled = typeof saved === "boolean" ? saved : DEFAULT_SETTING.enabled;
  return { enabled, updatedAt: row.updatedAt.toISOString(), updatedById: row.updatedById };
}

export async function writeShopifySyncSetting(db: Db, enabled: boolean, userId: string): Promise<ShopifySyncSetting> {
  const value = JSON.stringify({ enabled });
  await db.$executeRaw`INSERT INTO app_setting (key, value, updated_by_id, updated_at) VALUES (${SHOPIFY_CRM_SYNC_KEY}, ${value}::jsonb, ${userId}::uuid, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()`;
  return readShopifySyncSetting(db);
}

export async function decideShopifySyncForNewOrder(db: Db, now: Date): Promise<ShopifySyncDecision> {
  return { enabled: (await readShopifySyncSetting(db)).enabled, decidedAt: now.toISOString() };
}

/** Pure. The order's stored decision, or null for an order that has none (created before this feature, or from Shopify). */
export function storedShopifySyncDecision(metadata: unknown): ShopifySyncDecision | null {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const d = m.shopifySyncDecision;
  if (!d || typeof d !== "object") return null;
  const enabled = (d as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") return null;
  const decidedAt = (d as { decidedAt?: unknown }).decidedAt;
  return { enabled, decidedAt: typeof decidedAt === "string" ? decidedAt : "" };
}

/** Pure. Only a CRM-created order (source SALESPERSON) with a stored OFF decision is blocked; everything else is exactly as before. */
export function shopifyPushBlocked(order: { source: string; metadata: unknown }): boolean {
  return order.source === "SALESPERSON" && storedShopifySyncDecision(order.metadata)?.enabled === false;
}

export const SHOPIFY_SYNC_OFF_REASON = "Shopify sync for CRM-created orders is OFF: this order is saved in the CRM only and was not sent to Shopify.";
