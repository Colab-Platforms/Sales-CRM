// E7.7 Campaign & Bulk Messaging - batch sending. Campaign sending must never run as one huge
// synchronous HTTP request, so launchCampaign() (whatsapp.campaign.service.ts) only creates
// recipient rows; this module is the background worker that actually sends, ticking on the same
// in-process setInterval convention whatsapp.webhook.worker.ts and whatsapp.automation.scheduler.ts
// already use (this codebase has no Redis/Bull/Celery to introduce instead).
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";

// "50 recipients per batch" per the E7.7 spec's own example. CONCURRENCY caps how many of those 50
// are ever in flight to the provider at once - controlled concurrency, not thousands of
// simultaneous requests, and not one-at-a-time either.
export const BATCH_SIZE = 50;
export const CONCURRENCY = 5;

interface ClaimedRecipient {
  id: string;
  leadId: string;
  orderId: string | null;
}

/**
 * Atomically claims up to `batchSize` PENDING recipients: each claim is its own single-row
 * `UPDATE ... WHERE id = ? AND status = 'PENDING'`, so `count === 1` unambiguously means *this*
 * call won that row - the same "count tells you if you won" idiom this codebase's idempotent
 * inserts already use, applied to an UPDATE instead. Race-safe under concurrent worker ticks
 * without needing a separate claim-token column.
 */
export async function claimNextBatch(db: DbClient, campaignId: string, batchSize: number = BATCH_SIZE): Promise<ClaimedRecipient[]> {
  const candidates = await db.whatsAppCampaignRecipient.findMany({
    where: { campaignId, status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, leadId: true, orderId: true },
  });

  const claimed: ClaimedRecipient[] = [];
  for (const candidate of candidates) {
    const result = await db.whatsAppCampaignRecipient.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "CLAIMED", attemptedAt: new Date() },
    });
    if (result.count === 1) claimed.push(candidate);
  }
  return claimed;
}

async function processRecipient(db: DbClient, messaging: WhatsAppMessagingService, templateId: string, recipient: ClaimedRecipient): Promise<"sent" | "skipped" | "failed"> {
  try {
    const message = await messaging.sendTemplateAsSystem({ leadId: recipient.leadId, templateId, orderId: recipient.orderId ?? undefined });
    await db.whatsAppCampaignRecipient.update({ where: { id: recipient.id }, data: { status: "SENT", whatsAppMessageId: message.id, failureReason: null } });
    return "sent";
  } catch (error) {
    // An ApiError is an expected, already-descriptive precondition failure (template no longer
    // approved, no valid mobile, a required variable unavailable, WhatsApp not configured) - a
    // clean skip. One bad recipient never stops the batch or the campaign. Anything else is a
    // genuinely unexpected error, recorded as FAILED rather than silently swallowed.
    if (error instanceof ApiError) {
      await db.whatsAppCampaignRecipient.update({ where: { id: recipient.id }, data: { status: "SKIPPED", failureReason: error.message } });
      return "skipped";
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Campaign recipient processing failed unexpectedly", error);
    await db.whatsAppCampaignRecipient.update({ where: { id: recipient.id }, data: { status: "FAILED", failureReason: message } });
    return "failed";
  }
}

export interface BatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** Claims and processes one bounded batch for one campaign. Never throws: every recipient outcome is recorded on its own row. */
export async function processCampaignBatch(db: DbClient, messaging: WhatsAppMessagingService, campaignId: string, templateId: string, batchSize: number = BATCH_SIZE, concurrency: number = CONCURRENCY): Promise<BatchResult> {
  const batch = await claimNextBatch(db, campaignId, batchSize);
  const result: BatchResult = { claimed: batch.length, sent: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < batch.length; i += concurrency) {
    const slice = batch.slice(i, i + concurrency);
    const outcomes = await Promise.all(slice.map((r) => processRecipient(db, messaging, templateId, r)));
    for (const outcome of outcomes) result[outcome]++;
  }
  return result;
}

export interface TickResult {
  started: number;
  processed: number;
  completed: number;
}

/**
 * One scheduler tick: starts any SCHEDULED campaign whose time has come, then processes one batch
 * for every currently-RUNNING campaign, completing any that just ran out of PENDING recipients.
 * Each status transition (SCHEDULED->RUNNING, RUNNING->COMPLETED) is itself a WHERE-guarded update
 * (count===1 required), so two overlapping ticks - or a tick racing a user cancelling the same
 * campaign - can never double-start or double-complete the same campaign.
 */
export async function tickCampaigns(db: DbClient = prisma, getProvider?: () => WhatsAppProvider | null, now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = { started: 0, processed: 0, completed: 0 };

  const due = await db.whatsAppCampaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, select: { id: true } });
  for (const c of due) {
    const claim = await db.whatsAppCampaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "RUNNING", startedAt: now } });
    if (claim.count === 1) result.started++;
  }

  const running = await db.whatsAppCampaign.findMany({ where: { status: "RUNNING" }, select: { id: true, name: true, templateId: true } });
  for (const campaign of running) {
    const messaging = getProvider ? new WhatsAppMessagingService(db, getProvider) : new WhatsAppMessagingService(db);
    const batch = await processCampaignBatch(db, messaging, campaign.id, campaign.templateId);
    result.processed += batch.claimed;

    const remaining = await db.whatsAppCampaignRecipient.count({ where: { campaignId: campaign.id, status: { in: ["PENDING", "CLAIMED"] } } });
    if (remaining === 0) {
      const claim = await db.whatsAppCampaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "COMPLETED", completedAt: now } });
      if (claim.count === 1) {
        result.completed++;
        await db.activity.create({
          data: {
            type: ActivityType.WHATSAPP_CAMPAIGN_COMPLETED,
            referenceType: "WhatsAppCampaign",
            referenceId: campaign.id,
            source: ActivitySource.SYSTEM,
            title: `Campaign "${campaign.name}" completed`,
          },
        });
      }
    }
  }
  return result;
}

export interface SchedulerHandle {
  tick: () => Promise<void>;
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 60_000; // frequent enough that a launched campaign starts sending within about a minute

export function startCampaignScheduler(intervalMs = DEFAULT_INTERVAL_MS): SchedulerHandle {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await tickCampaigns();
      if (result.started || result.processed || result.completed) {
        logger.info(`WhatsApp campaign sweep: started ${result.started}, processed ${result.processed}, completed ${result.completed}`);
      }
    } catch (error) {
      logger.error("WhatsApp campaign sweep failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
