// "Order Created by <telecaller>": who created an order in the CRM, and the matching tag on the linked Shopify order.
//
// The creator is STRUCTURED data on the order, snapshotted at creation from the authenticated user's own User row (Order.createdById is the
// relation; Order.metadata.createdBy is the {id, name, role} snapshot, so the tag never depends on who is logged in later and survives a
// rename). The tag is derived from it - never taken from a request. It follows the same pattern as the confirmation tag (orders.confirmation.ts)
// and reuses the same Shopify tag calls: ADD-ONLY (existing Shopify tags are never changed or removed), idempotent (already there -> no
// Shopify write), and best-effort (a Shopify failure is remembered on Order.metadata.shopifyCreatorTag; the order is never undone and a retry is safe).
import type { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { ShopifyConfigError, loadShopifyConfig } from "../shopify/shopify.config.js";
import { addShopifyOrderTags, getShopifyOrderTags } from "../shopify/shopify.orders.write.js";

export const CREATOR_TAG_PREFIX = "Order Created by ";
const CREATOR_TAG = /^Order Created by\b/i;
// Shopify rejects any order tag longer than 40 characters; same rule and same shortening as the confirmation tag, so both systems read identically.
const MAX_TAG_LENGTH = 40;

export const isCreatorTag = (tag: string): boolean => CREATOR_TAG.test(tag.trim());

export function creatorTagFor(name: string): string {
  const clean = name.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  return `${CREATOR_TAG_PREFIX}${clean}`.slice(0, MAX_TAG_LENGTH).trim();
}

export interface CreatorSnapshot {
  id: string;
  name: string;
  role?: string;
}

/** The snapshot stored on an order, or null when the creator was never established (then NO creator tag exists - a misleading one is never made). */
export function creatorOf(metadata: unknown): CreatorSnapshot | null {
  const c = asRecord(asRecord(metadata).createdBy);
  return typeof c.id === "string" && typeof c.name === "string" && c.name.trim() ? { id: c.id, name: c.name, ...(typeof c.role === "string" ? { role: c.role } : {}) } : null;
}

/**
 * The snapshot to store when `actor` creates an order. The name is read from the actor's own User row - never from the request. Returns null (so
 * nothing is stored and no tag is made) when the user cannot be found.
 */
export async function resolveCreatorSnapshot(db: Pick<Db, "user">, actor: { id: string; role: Role }): Promise<CreatorSnapshot | null> {
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { id: true, name: true, username: true } });
  if (!user) return null;
  const name = (user.name?.trim() || user.username || "").slice(0, 150);
  return name ? { id: user.id, name, role: actor.role } : null;
}

export type CreatorTagSyncStatus = "synced" | "unchanged" | "not_linked" | "no_creator" | "failed";
export interface CreatorTagSyncResult {
  status: CreatorTagSyncStatus;
  tag?: string;
  reason?: string;
}

export interface CreatorTagSyncCtx {
  now?: Date;
  /** Re-check Shopify even if the CRM believes the tag is already in place (the manual retry). */
  force?: boolean;
  getShopifyClient?: () => ShopifyClient;
}

/**
 * Makes the linked Shopify order carry the creator's tag, leaving every other tag alone.
 *  - no creator snapshot: nothing is called, nothing is invented.
 *  - not linked to Shopify yet (no Shopify order id): nothing is called; it syncs when the order is linked.
 *  - already synced for this very tag: no Shopify call at all (idempotent), unless `force`; with `force` Shopify's tags are read and the tag is only added if missing.
 *  - Shopify down / scope missing: reported and remembered on the order for a retry; the order itself is untouched.
 */
export async function syncCreatorTag(db: Db, orderId: string, ctx: CreatorTagSyncCtx = {}): Promise<CreatorTagSyncResult> {
  const now = ctx.now ?? new Date();
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, externalSource: true, externalId: true, metadata: true } });
  const creator = order ? creatorOf(order.metadata) : null;
  if (!order || !creator) return { status: "no_creator" };
  if (order.externalSource !== "SHOPIFY" || !order.externalId) return { status: "not_linked", reason: "This order is not linked to a Shopify order yet." };

  const desired = creatorTagFor(creator.name);
  const state = asRecord(asRecord(order.metadata).shopifyCreatorTag);
  if (!ctx.force && state.status === "synced" && state.tag === desired) return { status: "unchanged", tag: desired };

  const remember = async (value: Record<string, unknown>) => {
    // Re-read right before writing so a concurrent metadata change (a payment sync, the confirmation tag) is not overwritten with a stale copy.
    const fresh = await db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
    await db.order.update({ where: { id: orderId }, data: { metadata: { ...asRecord(fresh?.metadata), shopifyCreatorTag: value } as Prisma.InputJsonValue } });
  };

  let client: ShopifyClient;
  try {
    client = (ctx.getShopifyClient ?? (() => new ShopifyClient(loadShopifyConfig())))();
  } catch (error) {
    const reason = error instanceof ShopifyConfigError ? error.message : safeMessage(error instanceof Error ? error.message : String(error));
    await remember({ status: "failed", tag: desired, failedAt: now.toISOString(), reason });
    return { status: "failed", tag: desired, reason };
  }

  try {
    const existing = await getShopifyOrderTags(client, order.externalId);
    const has = existing.some((t) => t.trim().toLowerCase() === desired.toLowerCase());
    if (!has) await addShopifyOrderTags(client, order.externalId, [desired]); // add-only: every existing tag stays exactly as it is
    await remember({ status: "synced", tag: desired, syncedAt: now.toISOString() });
    return { status: "synced", tag: desired };
  } catch (error) {
    const reason = safeMessage(error instanceof Error ? error.message : String(error));
    await remember({ status: "failed", tag: desired, failedAt: now.toISOString(), reason });
    logger.warn(`Shopify creator tag sync failed for order ${orderId}: ${reason}`);
    return { status: "failed", tag: desired, reason };
  }
}
