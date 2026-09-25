import {
  extractBusinessNumber,
  extractCallerNumber,
  extractDirection,
  extractExternalEventId,
  extractIvrDigit,
  extractProviderCallId,
} from "@modules/webhooks/exotel/payloadExtractors.js";
import {
  ProviderInitiationError,
  type InitiateOutboundCallInput,
  type InitiateOutboundCallResult,
  type NormalizeWebhookResult,
  type NormalizedCallDirection,
  type ProviderCallStatus,
  type TelephonyProvider,
} from "./provider.types.js";

function mapExotelDirection(direction: string | null): NormalizedCallDirection | null {
  switch (direction?.trim().toLowerCase()) {
    case "incoming":
      return "INBOUND";
    case "outbound-dial":
      return "OUTBOUND";
    default:
      return null;
  }
}

/**
 * Exotel = BACKUP provider.
 *
 * The existing Exotel IVR webhook module (modules/webhooks/exotel) is left untouched and
 * keeps serving `/api/webhooks/exotel/ivr`. This adapter only REUSES its payload extractors
 * to express Exotel events in the neutral shape.
 *
 * Outbound initiation is not implemented: the repository contains only the inbound IVR
 * passthru integration - no Exotel API credentials or outbound client exist. It fails
 * closed with NOT_DISPATCHED so it can never place (or duplicate) a call.
 */
export class ExotelProvider implements TelephonyProvider {
  readonly name = "EXOTEL" as const;

  isConfigured(): boolean {
    return false;
  }

  async initiateOutboundCall(_input: InitiateOutboundCallInput): Promise<InitiateOutboundCallResult> {
    throw new ProviderInitiationError(
      "EXOTEL",
      "NOT_DISPATCHED",
      "INITIATION_NOT_IMPLEMENTED",
      "Exotel outbound initiation is not implemented",
    );
  }

  async getCallStatus(_externalCallId: string): Promise<ProviderCallStatus | null> {
    return null;
  }

  normalizeWebhookEvent(rawPayload: unknown): NormalizeWebhookResult {
    if (rawPayload === null || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      return { ok: false, reason: "payload is not an object" };
    }

    const payload = rawPayload as Record<string, unknown>;
    const callSid = extractProviderCallId(payload);
    if (!callSid) return { ok: false, reason: "missing call id" };

    return {
      ok: true,
      event: {
        provider: "EXOTEL",
        eventType: "IVR_EVENT",
        externalCallId: callSid,
        dedupeKey: extractExternalEventId(payload),
        campaignId: null,
        direction: mapExotelDirection(extractDirection(payload)),
        sourceNumber: extractCallerNumber(payload),
        destinationNumber: extractBusinessNumber(payload),
        customerNumber: extractCallerNumber(payload),
        businessNumber: extractBusinessNumber(payload),
        agentNumber: null,
        status: null,
        rawStatus: null,
        failedLeg: null,
        durationSeconds: null,
        talkDurationSeconds: null,
        recordingUrl: null,
        startedAt: null,
        endedAt: null,
        agentPickedAt: null,
        customerLegStartedAt: null,
        customerPickedAt: null,
        errorCode: null,
        ivrDigit: extractIvrDigit(payload),
        rawPayload: payload,
      },
    };
  }
}
