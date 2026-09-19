import { randomUUID } from "node:crypto";
import { WebhookStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";

// Persistence for received webhook deliveries, on the existing webhook_events table.
// (provider, external_event_id) is unique, so a repeated delivery can never be recorded or processed twice.

export const PROVIDER = "SHOPIFY";
export const MAX_ATTEMPTS = 8;
/** How long a claim is held. If the process dies mid-way, the event becomes claimable again after this. */
export const LEASE_MS = 5 * 60 * 1000;
/** A delivery still unprocessed this long after arrival was probably lost with a restart. */
const STALE_RECEIVED_MS = 30 * 1000;

export interface StoredEvent {
  id: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

export interface WebhookStore {
  /** Records a delivery. `duplicate` is true if this delivery id was already recorded. */
  record(event: { eventType: string; externalEventId: string; payload: unknown; ignored?: boolean }): Promise<{ id: string; duplicate: boolean }>;
  /** Atomically takes an event for processing; null if it is not claimable (already done or held by someone else). */
  claim(id: string, now: Date): Promise<StoredEvent | null>;
  complete(id: string, status: "PROCESSED" | "IGNORED", now: Date): Promise<void>;
  fail(id: string, message: string, nextAttemptAt: Date | null): Promise<void>;
  /** Ids ready to be (re)processed: unprocessed leftovers, failures whose retry time has come, and expired claims. */
  due(now: Date, limit: number): Promise<string[]>;
}

/** Delay before retry number `attempts`: 1 min, 2 min, 4 min ... capped at 1 hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 60 * 60 * 1000);
}

export function createPrismaWebhookStore(db: Prisma.TransactionClient): WebhookStore {
  return {
    async record({ eventType, externalEventId, payload, ignored }) {
      // One atomic INSERT ... ON CONFLICT DO NOTHING on (provider, external_event_id): a repeat delivery inserts
      // nothing and raises no error, even if two copies arrive at the same instant.
      const id = randomUUID();
      const now = new Date();
      const { count } = await db.webhookEvent.createMany({
        data: [
          {
            id,
            provider: PROVIDER,
            eventType,
            externalEventId,
            payload: payload as Prisma.InputJsonValue,
            status: ignored ? WebhookStatus.IGNORED : WebhookStatus.RECEIVED,
            receivedAt: now,
            processedAt: ignored ? now : null,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) return { id, duplicate: false };

      const existing = await db.webhookEvent.findFirst({ where: { provider: PROVIDER, externalEventId }, select: { id: true } });
      return { id: existing?.id ?? "", duplicate: true };
    },

    async claim(id, now) {
      const claimed = await db.webhookEvent.updateMany({
        where: {
          id,
          provider: PROVIDER,
          OR: [
            { status: WebhookStatus.RECEIVED },
            { status: WebhookStatus.FAILED, nextAttemptAt: { lte: now } },
            { status: WebhookStatus.PROCESSING, nextAttemptAt: { lte: now } },
          ],
        },
        data: { status: WebhookStatus.PROCESSING, attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
      });
      if (claimed.count === 0) return null;
      const row = await db.webhookEvent.findUnique({ where: { id }, select: { id: true, eventType: true, payload: true, attempts: true } });
      return row;
    },

    async complete(id, status, now) {
      await db.webhookEvent.update({
        where: { id },
        data: { status: status === "PROCESSED" ? WebhookStatus.PROCESSED : WebhookStatus.IGNORED, processedAt: now, errorMessage: null, nextAttemptAt: null },
      });
    },

    async fail(id, message, nextAttemptAt) {
      await db.webhookEvent.update({
        where: { id },
        data: { status: WebhookStatus.FAILED, errorMessage: message.slice(0, 1000), nextAttemptAt },
      });
    },

    async due(now, limit) {
      const rows = await db.webhookEvent.findMany({
        where: {
          provider: PROVIDER,
          OR: [
            { status: WebhookStatus.RECEIVED, receivedAt: { lte: new Date(now.getTime() - STALE_RECEIVED_MS) } },
            { status: WebhookStatus.FAILED, nextAttemptAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
            { status: WebhookStatus.PROCESSING, nextAttemptAt: { lte: now } },
          ],
        },
        orderBy: { receivedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
  };
}
