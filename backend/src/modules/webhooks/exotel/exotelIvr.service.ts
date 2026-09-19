import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { normalizePhone } from "@/utils/phone.js";
import { logger } from "@/utils/logger.js";
import type { Prisma } from "@root/generated/prisma/client.js";
import { WebhookStatus } from "@root/generated/prisma/client.js";
import {
  extractProviderCallId,
  extractCallerNumber,
  extractBusinessNumber,
  extractDirection,
  extractExternalEventId,
  extractIvrDigit,
} from "./payloadExtractors.js";
import { resolveIvrOption, resolveIvrAction } from "./ivrOptions.js";

const PROVIDER = "exotel";
const EVENT_TYPE = "ivr_event";

export interface ExotelIvrResult {
  webhookEventId: string;
  provider: "exotel";
  eventType: string;
  duplicate: boolean;
  callMatched: boolean;
  leadMatched: boolean;
  leadMatchAmbiguous: boolean;
  providerCallId: string | null;
  callerNumber: string | null;
  businessNumber: string | null;
  direction: string | null;
  ivrDigit: string | null;
  ivrOption: string | null;
  ivrAction: string;
  processingFailed: boolean;
}

export async function processExotelIvrWebhook(payload: Record<string, unknown>): Promise<ExotelIvrResult> {
  const externalEventId = extractExternalEventId(payload);
  const providerCallId = extractProviderCallId(payload);
  const callerNumberRaw = extractCallerNumber(payload);
  const businessNumber = extractBusinessNumber(payload);
  const direction = extractDirection(payload);
  const digit = extractIvrDigit(payload);
  const ivrOption = digit !== null ? resolveIvrOption(digit) : null;
  const ivrAction = resolveIvrAction(ivrOption);

  // NOTE: externalEventId only ever comes from a distinct event/request id
  // field (never CallSid) — see TODO in payloadExtractors.ts. A single call
  // legitimately produces multiple Passthru events, so CallSid must never be
  // used to deduplicate.
  if (externalEventId) {
    const existing = await prisma.webhookEvent.findFirst({
      where: { provider: PROVIDER, externalEventId: externalEventId },
      orderBy: { receivedAt: "desc" },
    });

    if (existing) {
      logger.info(
        `Exotel IVR webhook duplicate ignored: webhookEventId=${existing.id} externalEventId=${externalEventId}`,
      );
      return {
        webhookEventId: existing.id,
        provider: "exotel",
        eventType: existing.eventType,
        duplicate: true,
        callMatched: false,
        leadMatched: false,
        leadMatchAmbiguous: false,
        providerCallId,
        callerNumber: callerNumberRaw,
        businessNumber,
        direction,
        ivrDigit: digit,
        ivrOption,
        ivrAction,
        processingFailed: false,
      };
    }
  }

  // Store the raw event first — this must survive even if correlation below fails.
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      id: randomUUID(),
      provider: PROVIDER,
      eventType: EVENT_TYPE,
      externalEventId: externalEventId,
      payload: payload as Prisma.InputJsonValue,
      status: WebhookStatus.RECEIVED,
      receivedAt: new Date(),
    },
  });

  try {
    let callMatched = false;
    if (providerCallId) {
      // provider_call_id is intentionally NOT unique in the schema — a
      // single CallSid can have multiple webhook_events/call rows over its
      // lifecycle, so this only checks existence, never assumes exactly one.
      const matchedCall = await prisma.call.findFirst({
        where: { providerCallId: providerCallId },
        select: { id: true },
      });
      callMatched = matchedCall !== null;
    }

    let leadMatched = false;
    let leadMatchAmbiguous = false;
    if (callerNumberRaw) {
      const normalizedMobile = normalizePhone(callerNumberRaw);
      if (normalizedMobile) {
        const matchedLeads = await prisma.lead.findMany({
          where: { normalizedMobile: normalizedMobile },
          select: { id: true },
        });
        if (matchedLeads.length === 1) leadMatched = true;
        else if (matchedLeads.length > 1) leadMatchAmbiguous = true;
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: WebhookStatus.PROCESSED, processedAt: new Date() },
    });

    logger.info(
      `Exotel IVR webhook processed: webhookEventId=${webhookEvent.id} eventType=${EVENT_TYPE} callMatched=${callMatched} leadMatched=${leadMatched} leadMatchAmbiguous=${leadMatchAmbiguous} ivrOption=${ivrOption ?? "none"}`,
    );

    return {
      webhookEventId: webhookEvent.id,
      provider: "exotel",
      eventType: EVENT_TYPE,
      duplicate: false,
      callMatched,
      leadMatched,
      leadMatchAmbiguous,
      providerCallId,
      callerNumber: callerNumberRaw,
      businessNumber,
      direction,
      ivrDigit: digit,
      ivrOption,
      ivrAction,
      processingFailed: false,
    };
  } catch (err) {
    const safeMessage = err instanceof Error ? err.message : "Unknown error while processing webhook event";

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: WebhookStatus.FAILED, errorMessage: safeMessage.slice(0, 500) },
    });

    logger.error(`Exotel IVR webhook processing failed: webhookEventId=${webhookEvent.id}`, safeMessage);

    return {
      webhookEventId: webhookEvent.id,
      provider: "exotel",
      eventType: EVENT_TYPE,
      duplicate: false,
      callMatched: false,
      leadMatched: false,
      leadMatchAmbiguous: false,
      providerCallId,
      callerNumber: callerNumberRaw,
      businessNumber,
      direction,
      ivrDigit: digit,
      ivrOption,
      ivrAction,
      processingFailed: true,
    };
  }
}
