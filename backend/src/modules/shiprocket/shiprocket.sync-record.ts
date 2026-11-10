// The Shiprocket submission state of a CRM-created order, kept in Order.metadata.shiprocketSync. It is deliberately a different key from Shopify's (metadata.shopifySync /
// shopifySyncDecision): the two integrations never read or overwrite each other's status.
import type { Prisma } from "../../../generated/prisma/client.js";
import { asRecord } from "../integrations/integrations.common.js";

export type ShiprocketSyncStatus = "PENDING" | "SYNCED" | "FAILED" | "AWAITING_PAYMENT" | "AWAITING_SHOPIFY" | "NOT_CONFIGURED";

export interface ShiprocketSyncRecord {
  status: ShiprocketSyncStatus;
  attempts: number;
  lastAttemptAt: string | null;
  syncedAt: string | null;
  /** Shiprocket's own order id (providerOrderId) once it accepted the order. */
  shiprocketOrderId: string | null;
  /** The order id the CRM sent: the Shopify order reference when the order is linked to Shopify, otherwise the CRM order number. */
  channelOrderId: string | null;
  /** The mapping kept for reconciliation: the CRM order number and the Shopify order the Shiprocket order was created for (null when the order is not a Shopify order). */
  crmOrderNumber?: string | null;
  shopifyOrderId?: string | null;
  shopifyOrderName?: string | null;
  /** Safe, user-readable reason of the last failure; null when none. */
  error: string | null;
  trigger: string | null;
}

/** Pure. The stored record, or null when the order was never submitted / has none. */
export function readShiprocketSync(metadata: unknown): ShiprocketSyncRecord | null {
  const r = asRecord(asRecord(metadata).shiprocketSync);
  if (typeof r.status !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status: r.status as ShiprocketSyncStatus,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    lastAttemptAt: str(r.lastAttemptAt),
    syncedAt: str(r.syncedAt),
    shiprocketOrderId: str(r.shiprocketOrderId),
    channelOrderId: str(r.channelOrderId),
    crmOrderNumber: str(r.crmOrderNumber),
    shopifyOrderId: str(r.shopifyOrderId),
    shopifyOrderName: str(r.shopifyOrderName),
    error: str(r.error),
    trigger: str(r.trigger),
  };
}

type Raw = Pick<Prisma.TransactionClient, "$executeRaw">;

/** Atomically merges `patch` into metadata.shiprocketSync (one UPDATE: a concurrent writer of any other metadata key is not overwritten). */
export async function mergeShiprocketSync(db: Raw, orderId: string, patch: Partial<ShiprocketSyncRecord>): Promise<void> {
  const json = JSON.stringify(patch);
  await db.$executeRaw`UPDATE orders SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('shiprocketSync', COALESCE(metadata->'shiprocketSync', '{}'::jsonb) || ${json}::jsonb) WHERE id = ${orderId}::uuid`;
}
