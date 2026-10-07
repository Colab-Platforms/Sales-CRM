// "CRM Confirmed by <telecaller>": who confirmed an order in the CRM, and the matching tag on the linked Shopify order.
//
// The confirmer is STRUCTURED data on the order (confirmedByUserId = the authenticated CRM user, confirmedByName = snapshot, confirmedAt);
// the tag is derived from it - never the other way round. Earlier confirmers stay in the Activity log (ORDER_CONFIRMED rows).
// The Shopify tag is a best-effort follow-up: it can fail without ever undoing the confirmation, the failure is remembered on
// Order.metadata.shopifyConfirmationTag (same pattern as shopifyPaymentSync) and a retry is always safe. Only tags starting with
// "CRM Confirmed by " are ever added/removed - every other Shopify tag is left exactly as it is.
import { ActivitySource, ActivityType, type Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { ShopifyConfigError, loadShopifyConfig } from "../shopify/shopify.config.js";
import { addShopifyOrderTags, getShopifyOrderTags, removeShopifyOrderTags } from "../shopify/shopify.orders.write.js";

export const CONFIRMATION_TAG_PREFIX = "CRM Confirmed by ";
const CONFIRMATION_TAG = /^CRM Confirmed by\b/i;
// Shopify rejects any order tag longer than 40 characters ("Order tags is invalid") - verified live. The prefix is 17, so a name
// longer than 23 characters is shortened. The CRM shows the same shortened tag, so both systems always read identically.
const MAX_TAG_LENGTH = 40;

export const isConfirmationTag = (tag: string): boolean => CONFIRMATION_TAG.test(tag.trim());

/** Shopify tags cannot contain commas and are capped at 40 characters; whitespace is collapsed so the same person always yields the same tag. */
export function confirmationTagFor(name: string): string {
  const clean = name.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  return `${CONFIRMATION_TAG_PREFIX}${clean}`.slice(0, MAX_TAG_LENGTH).trim();
}

/** What to change on an order that currently has `existing` so that exactly `desired` is its CRM confirmation tag. Nothing else is touched. */
export function planTagChange(existing: string[], desired: string): { add: string[]; remove: string[] } {
  const lower = desired.toLowerCase();
  const remove = existing.filter((t) => isConfirmationTag(t) && t.trim().toLowerCase() !== lower);
  const has = existing.some((t) => t.trim().toLowerCase() === lower);
  return { add: has ? [] : [desired], remove };
}

export interface ConfirmationActor {
  id: string;
  role: Role;
}

export interface ConfirmationRecord {
  changed: boolean;
  confirmedByUserId: string;
  confirmedByName: string;
  previousConfirmedByUserId: string | null;
  previousConfirmedByName: string | null;
}

/**
 * Records `actor` as the order's current confirmer. The name always comes from the User row of the authenticated actor - never from
 * the request. Confirming again as the SAME person changes nothing; a different person replaces the current confirmer and the change
 * is written to the Activity log. Runs on the caller's transaction.
 */
export async function recordConfirmation(tx: Db, orderId: string, actor: ConfirmationActor, now: Date = new Date()): Promise<ConfirmationRecord> {
  const [user, order] = await Promise.all([
    tx.user.findUnique({ where: { id: actor.id }, select: { id: true, name: true, email: true } }),
    tx.order.findUnique({ where: { id: orderId }, select: { id: true, leadId: true, orderNumber: true, confirmedByUserId: true, confirmedByName: true, confirmedAt: true } }),
  ]);
  if (!user) throw new Error("The confirming user no longer exists");
  if (!order) throw new Error("Order not found");
  const name = (user.name?.trim() || user.email.split("@")[0] || "CRM user").slice(0, 150);
  const base = { confirmedByUserId: user.id, confirmedByName: name, previousConfirmedByUserId: order.confirmedByUserId, previousConfirmedByName: order.confirmedByName };
  if (order.confirmedByUserId === user.id && order.confirmedAt) return { changed: false, ...base };

  await tx.order.update({ where: { id: orderId }, data: { confirmedByUserId: user.id, confirmedByName: name, confirmedAt: now } });
  await tx.activity.create({
    data: {
      leadId: order.leadId,
      orderId,
      actorId: user.id,
      actorRole: actor.role,
      type: ActivityType.ORDER_CONFIRMED,
      referenceType: "Order",
      referenceId: orderId,
      source: ActivitySource.USER,
      title: order.confirmedByUserId ? `Order confirmed by ${name} (was ${order.confirmedByName ?? "another user"})` : `Order confirmed by ${name}`,
      metadata: { confirmedByUserId: user.id, confirmedByName: name, previousConfirmedByUserId: order.confirmedByUserId, previousConfirmedByName: order.confirmedByName },
      createdAt: now,
    },
  });
  return { changed: true, ...base };
}

export type ConfirmationTagSyncStatus = "synced" | "unchanged" | "not_linked" | "not_confirmed" | "failed";
export interface ConfirmationTagSyncResult {
  status: ConfirmationTagSyncStatus;
  tag?: string;
  reason?: string;
}

export interface TagSyncCtx {
  now?: Date;
  /** Re-check Shopify even if the CRM believes the tag is already in place (the manual retry). */
  force?: boolean;
  getShopifyClient?: () => ShopifyClient;
}

const MAX_PASSES = 3;

/**
 * Makes the linked Shopify order carry exactly the current confirmer's tag, leaving every other tag alone.
 *  - not confirmed yet / not linked to Shopify (no Shopify order id): nothing is called; it syncs later, when the order is linked.
 *  - already synced for this very tag: no Shopify call at all (idempotent), unless `force`.
 *  - confirmer changed: the previous "CRM Confirmed by X" tag is removed and the new one added, so only the current one remains.
 *  - Shopify down / scope missing: reported and remembered on the order for a retry; the confirmation itself is never undone.
 */
export async function syncConfirmationTag(db: Db, orderId: string, ctx: TagSyncCtx = {}): Promise<ConfirmationTagSyncResult> {
  const now = ctx.now ?? new Date();
  let last: ConfirmationTagSyncResult = { status: "not_confirmed" };

  // A confirmer change that lands while Shopify is being called must not leave the old tag behind: re-evaluate until it is stable.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, externalSource: true, externalId: true, confirmedByUserId: true, confirmedByName: true, metadata: true } });
    if (!order || !order.confirmedByUserId || !order.confirmedByName) return { status: "not_confirmed" };
    if (order.externalSource !== "SHOPIFY" || !order.externalId) return { status: "not_linked", reason: "This order is not linked to a Shopify order yet." };

    const desired = confirmationTagFor(order.confirmedByName);
    const meta = asRecord(order.metadata);
    const state = asRecord(meta.shopifyConfirmationTag);
    if (!ctx.force && state.status === "synced" && state.tag === desired) return { status: "unchanged", tag: desired };

    const remember = async (value: Record<string, unknown>) => {
      // Re-read right before writing so a concurrent metadata change (e.g. a payment sync) is not overwritten with a stale copy.
      const fresh = await db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
      await db.order.update({ where: { id: orderId }, data: { metadata: { ...asRecord(fresh?.metadata), shopifyConfirmationTag: value } as Prisma.InputJsonValue } });
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
      const plan = planTagChange(existing, desired);
      // Add FIRST, then remove: if Shopify refuses the new tag nothing has been removed, so the order is never left with no
      // confirmation tag at all (the retry then re-attempts the whole change).
      await addShopifyOrderTags(client, order.externalId, plan.add);
      await removeShopifyOrderTags(client, order.externalId, plan.remove);
      await remember({ status: "synced", tag: desired, syncedAt: now.toISOString(), removed: plan.remove });
      last = { status: "synced", tag: desired };
    } catch (error) {
      const reason = safeMessage(error instanceof Error ? error.message : String(error));
      await remember({ status: "failed", tag: desired, failedAt: now.toISOString(), reason });
      logger.warn(`Shopify confirmation tag sync failed for order ${orderId}: ${reason}`);
      return { status: "failed", tag: desired, reason };
    }

    const after = await db.order.findUnique({ where: { id: orderId }, select: { confirmedByName: true } });
    if (after?.confirmedByName === order.confirmedByName) return last;
  }
  return last;
}
