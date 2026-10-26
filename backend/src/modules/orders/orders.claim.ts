import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";

// ONE write operation at a time per order, shared by every action that edits an existing order or its Shopify twin (flavour change, address change, Sync from CRM). The same pattern as the Shopify push claim: a
// conditional UPDATE on the order row, so it holds across requests and processes. A second request while one is running is refused (409) instead of opening a second Shopify edit. The claim is released on
// success, on every error and exception; one left behind by a dead process expires after the lease.
const CLAIM_LEASE_SECONDS = 120;

export async function withOrderEditClaim<T>(db: DbClient, orderId: string, work: () => Promise<T>): Promise<T> {
  const claimed = await db.$executeRaw`UPDATE orders SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{orderEditClaimedAt}', to_jsonb(now()::text)) WHERE id = ${orderId}::uuid AND (metadata->>'orderEditClaimedAt' IS NULL OR (metadata->>'orderEditClaimedAt')::timestamptz < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS}))`;
  if (claimed === 0) throw new ApiError("Another change to this order is already in progress. Wait a moment, then check the order and try again.", STATUS_CODES.CONFLICT);
  try {
    return await work();
  } finally {
    try {
      await db.$executeRaw`UPDATE orders SET metadata = metadata - 'orderEditClaimedAt' WHERE id = ${orderId}::uuid AND metadata ? 'orderEditClaimedAt'`;
    } catch (error) {
      logger.error(`Could not release the edit claim on order ${orderId} (it expires by itself)`, error instanceof Error ? error.message : String(error));
    }
  }
}
