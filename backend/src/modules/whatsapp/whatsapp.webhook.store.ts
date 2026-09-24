import { randomUUID } from "node:crypto";
import { WebhookStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { WhatsAppProviderId } from "./whatsapp.provider.js";

// Delivery-level idempotency for WhatsApp webhooks, reusing the same webhook_events table Shopify
// uses (webhooks.prisma) rather than a second table - only the `provider` value differs
// ("AISENSY"/"GUPSHUP" vs "SHOPIFY"). The claim/lease/backoff logic below deliberately mirrors
// shopify.webhook.store.ts's proven pattern; it is not imported from there so this module has no
// dependency on the Shopify integration and E6's tested file stays untouched.

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 5 * 60 * 1000;
const STALE_RECEIVED_MS = 30 * 1000;

export interface StoredEvent {
  id: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

export interface WebhookStore {
  record(event: { eventType: string; externalEventId: string; payload: unknown; ignored?: boolean }): Promise<{ id: string; duplicate: boolean }>;
  claim(id: string, now: Date): Promise<StoredEvent | null>;
  complete(id: string, status: "PROCESSED" | "IGNORED", now: Date): Promise<void>;
  fail(id: string, message: string, nextAttemptAt: Date | null): Promise<void>;
  due(now: Date, limit: number): Promise<string[]>;
}

export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 60 * 60 * 1000);
}

export function createWhatsAppWebhookStore(db: Prisma.TransactionClient, provider: WhatsAppProviderId): WebhookStore {
  return {
    async record({ eventType, externalEventId, payload, ignored }) {
      const id = randomUUID();
      const now = new Date();
      const { count } = await db.webhookEvent.createMany({
        data: [
          {
            id,
            provider,
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

      const existing = await db.webhookEvent.findFirst({ where: { provider, externalEventId }, select: { id: true } });
      return { id: existing?.id ?? "", duplicate: true };
    },

    async claim(id, now) {
      const claimed = await db.webhookEvent.updateMany({
        where: {
          id,
          provider,
          OR: [
            { status: WebhookStatus.RECEIVED },
            { status: WebhookStatus.FAILED, nextAttemptAt: { lte: now } },
            { status: WebhookStatus.PROCESSING, nextAttemptAt: { lte: now } },
          ],
        },
        data: { status: WebhookStatus.PROCESSING, attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
      });
      if (claimed.count === 0) return null;
      return db.webhookEvent.findUnique({ where: { id }, select: { id: true, eventType: true, payload: true, attempts: true } });
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
          provider,
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
