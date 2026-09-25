import type { CallStatus } from "@root/generated/prisma/enums.js";

/**
 * Provider-neutral telephony types.
 *
 * Nothing in this file (or anything the frontend can reach) may expose a
 * provider-specific status, field name or response shape. Provider adapters
 * translate to/from these types at the edge.
 */

export type TelephonyProviderName = "CALLERDESK" | "EXOTEL";

/** Lower-case value persisted in `webhook_events.provider` / `calls.provider` (matches existing "exotel" rows). */
export function providerDbValue(provider: TelephonyProviderName): string {
  return provider.toLowerCase();
}

export type NormalizedCallEventType = "CALL_REPORT" | "LIVE_CALL" | "IVR_EVENT";

export type NormalizedCallDirection = "INBOUND" | "OUTBOUND";

export interface NormalizedCallEvent {
  provider: TelephonyProviderName;
  eventType: NormalizedCallEventType;

  /** The provider's unique call identifier (CallerDesk `CallSid`). Always present on a valid event. */
  externalCallId: string;

  /**
   * Stable per-event key used for webhook idempotency (`webhook_events.external_event_id`).
   * Identical for provider retries of the same event; differs between distinct events of one call.
   * `null` when the provider gives nothing stable to dedupe on.
   */
  dedupeKey: string | null;

  /** Outbound click-to-call request id, when the provider supplies one. */
  campaignId: string | null;

  direction: NormalizedCallDirection | null;

  /** Numbers exactly as the provider sent them (trimmed). Semantics depend on direction, see below. */
  sourceNumber: string | null;
  destinationNumber: string | null;

  /**
   * Resolved parties. Only populated where the provider documents the mapping;
   * `null` means "unknown", never "guess".
   */
  customerNumber: string | null;
  businessNumber: string | null;
  agentNumber: string | null;

  /** Internal status. `null` = provider status was not recognised (caller decides the safe fallback). */
  status: CallStatus | null;
  /** Provider status string as received. For logging/diagnostics only - never expose to the frontend. */
  rawStatus: string | null;
  /** Which leg failed, when the provider says so. */
  failedLeg: "AGENT" | "CUSTOMER" | null;

  durationSeconds: number | null;
  talkDurationSeconds: number | null;

  recordingUrl: string | null;

  startedAt: Date | null;
  endedAt: Date | null;
  agentPickedAt: Date | null;
  customerLegStartedAt: Date | null;
  customerPickedAt: Date | null;

  errorCode: string | null;

  /** IVR digit, for IVR-style events. */
  ivrDigit: string | null;

  rawPayload: Record<string, unknown>;
}

export type NormalizeWebhookResult =
  | { ok: true; event: NormalizedCallEvent }
  | { ok: false; reason: string };

export interface InitiateOutboundCallInput {
  /** Our own Call row id, created before dialling so provider retries can be tied back to it. */
  callId: string;
  leadId: string;
  /** Agent's phone number (rings first). */
  agentNumber: string;
  /** Customer's phone number. */
  customerNumber: string;
  /** Business calling identity (virtual number / CLI) to present, when configured. */
  businessNumber: string | null;
}

export interface InitiateOutboundCallResult {
  /** The provider that actually accepted the call (may be the backup after a fallback). */
  provider: TelephonyProviderName;
  /**
   * The identifier to store on the Call row so later webhooks can be correlated to it.
   * For CallerDesk this is the `campid` returned at initiation (the CallSid only arrives
   * later, via webhook). `null` when the provider accepted the call but returned no id.
   */
  providerCallId: string | null;
  /** Provider request/campaign id, when it is distinct from `providerCallId`. */
  campaignId: string | null;
  /** Internal status right after acceptance - always INITIATED; later states arrive via webhooks. */
  status: CallStatus;
}

export interface ProviderCallStatus {
  status: CallStatus;
  durationSeconds: number | null;
}

/**
 * Outcome classification for a failed initiation. This is what decides whether
 * falling back to the backup provider is safe.
 *
 * - NOT_DISPATCHED: we are certain no call was placed (not configured, request
 *   rejected before dialling, connection refused). Fallback is safe.
 * - UNCERTAIN: a call MAY have been placed (timeout, connection reset, 5xx,
 *   unparseable success). Fallback is NOT safe - it could ring the customer twice.
 */
export type InitiationFailureKind = "NOT_DISPATCHED" | "UNCERTAIN";

export class ProviderInitiationError extends Error {
  readonly provider: TelephonyProviderName;
  readonly kind: InitiationFailureKind;
  readonly code: string;

  constructor(provider: TelephonyProviderName, kind: InitiationFailureKind, code: string, message: string) {
    super(message);
    this.name = "ProviderInitiationError";
    this.provider = provider;
    this.kind = kind;
    this.code = code;
    Object.setPrototypeOf(this, ProviderInitiationError.prototype);
  }
}

export interface TelephonyProvider {
  readonly name: TelephonyProviderName;

  /** True when the credentials/config needed to place calls are present. */
  isConfigured(): boolean;

  /**
   * Place an outbound (agent-first) call. Must throw `ProviderInitiationError`
   * with an accurate `kind`; any other thrown error is treated as UNCERTAIN.
   */
  initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiateOutboundCallResult>;

  /** Pull current status from the provider. `null` when the provider has no documented status API. */
  getCallStatus(externalCallId: string): Promise<ProviderCallStatus | null>;

  /** Translate a raw provider webhook body into the neutral event. Never throws. */
  normalizeWebhookEvent(rawPayload: unknown): NormalizeWebhookResult;
}
