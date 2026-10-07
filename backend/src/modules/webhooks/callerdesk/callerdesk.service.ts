import { CallDirection, CallStatus, WebhookStatus } from "@root/generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import { buildMobileLookupCandidates, normalizePhone } from "@/utils/phone.js";
// Lead matching reuses the exact same canonical-identity + legacy-shape tolerance every other
// inbound-identity match in this CRM already agrees on (see whatsapp.matching.ts's own header
// comment and the real production bug it documents) - NOT buildMobileLookupCandidates above, which
// predates @/lib/leadIdentity.js's "+"-prefixed canonical format and would never match it. That
// helper is still correct and unrelated here: virtualNumberCandidates (below) matches a DID against
// VirtualNumber.number, a completely different column with no such canonical format.
import { legacyMatchCandidates } from "@modules/whatsapp/whatsapp.matching.js";
import { providerDbValue, type NormalizedCallEvent } from "@modules/telephony/provider.types.js";
import { normalizeCallerDeskPayload } from "./callerdesk.payload.js";
import { callStatusRank, isTerminalCallStatus } from "./callerdesk.status.js";
import type { CallEventStore, CallEventTx, CallPatch, StoredCall } from "./callerdesk.store.js";

/**
 * CallerDesk webhook processing.
 *
 * IDEMPOTENCY
 *  - Every delivery is keyed by (provider, eventType, dedupeKey): Call Report = CallSid;
 *    Live Call = CallSid + Status. A key already PROCESSED/IGNORED is answered as a
 *    duplicate and does nothing else. A key left RECEIVED (unmatched / interrupted) or
 *    FAILED is re-attempted, since the retry may now correlate.
 *  - All work for one CallSid runs under a Postgres transaction-scoped advisory lock,
 *    so concurrent deliveries (retries, or a Live and a Report event racing) cannot both
 *    create a Call. The schema has no unique constraint on calls.provider_call_id or
 *    webhook_events.external_event_id, so this lock is what prevents duplicates.
 *  - Recording is upserted on the unique call_id; the CALL Activity is created at most
 *    once per call (checked via its reference); no follow-up tasks are ever created here.
 *
 * WEBHOOK EVENT STATUS
 *  - PROCESSED: correlated to a Call and applied.
 *  - RECEIVED : stored but not (yet) correlated - awaiting reconciliation / a retry.
 *  - IGNORED  : deliberately not applied (e.g. Live event with an unrecognised status).
 *  - FAILED   : an unexpected error; the raw payload is still persisted.
 *
 * CORRELATION (first match wins; never attaches to an arbitrary lead)
 *  1. calls.provider_call_id = CallSid
 *  2. OUTBOUND only: calls.provider_call_id = campid (a click-to-call request id stored at
 *     initiation); on a match the row is upgraded to the real CallSid
 *  3. INBOUND only: caller number -> exactly one lead. 2+ leads = unmatched (never guessed).
 *     0 leads = "IVR caller = Lead": a new, unassigned Lead is created (source "IVR Inquiry",
 *     see createIvrLead in callerdesk.store.ts) and used from here on, same as a match.
 *     The agent is the active user whose phone equals DialWhomNumber, else the lead owner;
 *     with neither, the event stays unmatched (calls.agent_id is required) - the Lead already
 *     committed still appears in Leads, only the Call is deferred to the next delivery/retry.
 *  Otherwise the event is stored unmatched.
 */

export type CorrelationMethod = "PROVIDER_CALL_ID" | "CAMPAIGN_ID" | "PHONE_NUMBER";

export type UnmatchedReason =
  | "NO_CALL_MATCH_OUTBOUND"
  | "UNKNOWN_DIRECTION"
  | "NO_CUSTOMER_NUMBER"
  | "NO_LEAD_MATCH"
  | "AMBIGUOUS_LEAD_MATCH"
  | "NO_AGENT_RESOLVED";

export type CallerDeskWebhookResult =
  | { outcome: "INVALID"; reason: string }
  | { outcome: "DUPLICATE"; webhookEventId: string }
  | {
      outcome: "PROCESSED";
      webhookEventId: string;
      callId: string;
      leadId: string;
      leadCreated: boolean;
      correlation: CorrelationMethod;
      callCreated: boolean;
      recording: "created" | "updated" | "unchanged" | "none";
      activityCreated: boolean;
    }
  | { outcome: "UNMATCHED"; webhookEventId: string; reason: UnmatchedReason; leadId?: string }
  | { outcome: "IGNORED"; webhookEventId: string; reason: string }
  | { outcome: "FAILED" };

export interface CallerDeskServiceOptions {
  /** UTC offset for CallerDesk's naive timestamps. */
  timestampUtcOffset?: string;
  now?: () => Date;
}

const STATUS_LABELS: Record<CallStatus, string> = {
  INITIATED: "Initiated",
  RINGING_AGENT: "Ringing agent",
  AGENT_ANSWERED: "Agent answered",
  RINGING_CUSTOMER: "Ringing customer",
  CONNECTED: "Connected",
  COMPLETED: "Completed",
  NO_ANSWER: "No answer",
  BUSY: "Busy",
  NOT_REACHABLE: "Not reachable",
  FAILED: "Failed",
};

/** Make attacker-controlled strings safe and bounded for log lines. */
function logToken(value: string | null | undefined, max = 60): string {
  if (!value) return "none";
  return value.replace(/[^\w.\-|:() ]/g, "?").slice(0, max);
}

/** Diagnostic-only: last 4 digits, never the full number - the README's "no phone numbers logged"
 * mitigation stays intact (a 4-digit suffix alone cannot be dialled or used to look someone up),
 * while still letting a log line be matched back to a specific real test call during UAT. */
function maskPhone(value: string | null | undefined): string {
  if (!value) return "none";
  const digits = value.replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "none";
}

type Correlation =
  | { kind: "CALL"; call: StoredCall; method: "PROVIDER_CALL_ID" | "CAMPAIGN_ID" }
  | { kind: "CREATE"; leadId: string; agentId: string; virtualNumberId: string | null; leadCreated: boolean }
  | { kind: "UNMATCHED"; reason: UnmatchedReason; leadId?: string };

function eventTypeDbValue(event: NormalizedCallEvent): string {
  return event.eventType === "CALL_REPORT" ? "call_report" : "live_call";
}

function virtualNumberCandidates(event: NormalizedCallEvent): string[] {
  const raw = event.businessNumber ?? event.destinationNumber;
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  return [...new Set([raw.trim(), digits, ...buildMobileLookupCandidates(raw)].filter((v) => v.length > 0))];
}

async function resolveAgentId(tx: CallEventTx, event: NormalizedCallEvent, leadOwnerId: string | null): Promise<string | null> {
  const answeringNumber = event.agentNumber ? normalizePhone(event.agentNumber) : null;

  if (answeringNumber && answeringNumber.length === 10) {
    const users = await tx.findActiveUsersWithPhone();
    const matches = users.filter((user) => normalizePhone(user.phone) === answeringNumber);
    if (matches.length === 1) return matches[0]!.id;
    // 0 matches (e.g. a shared desk phone) or 2+ (ambiguous) -> do not guess from the number.
  }

  return leadOwnerId;
}

async function correlate(tx: CallEventTx, event: NormalizedCallEvent, provider: string): Promise<Correlation> {
  const byCallSid = await tx.findCallByProviderCallId({ provider, providerCallId: event.externalCallId });
  if (byCallSid) return { kind: "CALL", call: byCallSid, method: "PROVIDER_CALL_ID" };

  if (event.direction === "OUTBOUND" && event.campaignId) {
    const byCampaign = await tx.findCallByProviderCallId({
      provider,
      providerCallId: event.campaignId,
      direction: CallDirection.OUTBOUND,
    });
    if (byCampaign) return { kind: "CALL", call: byCampaign, method: "CAMPAIGN_ID" };
  }

  if (event.direction === null) return { kind: "UNMATCHED", reason: "UNKNOWN_DIRECTION" };
  // CallerDesk does not document which number is the customer on outgoing calls, so an
  // outbound event with no matching provider/campaign id is never matched by phone number.
  if (event.direction === "OUTBOUND") return { kind: "UNMATCHED", reason: "NO_CALL_MATCH_OUTBOUND" };

  if (!event.customerNumber) return { kind: "UNMATCHED", reason: "NO_CUSTOMER_NUMBER" };

  // event.customerNumber is already normalizeMobile's canonical "+"-prefixed form (see
  // callerdesk.payload.ts's toDigits) - legacyMatchCandidates only needs to add the legacy shapes
  // real leads may still be stored under, not rebuild the canonical form itself.
  const leads = await tx.findLeadsByNormalizedMobile(legacyMatchCandidates(event.customerNumber));
  if (leads.length > 1) return { kind: "UNMATCHED", reason: "AMBIGUOUS_LEAD_MATCH" };

  // "IVR caller = Lead": a first-time caller becomes a new, unassigned Lead (source "IVR Inquiry"),
  // created here before the Call row - Call.leadId stays required, no migration needed. If agent
  // resolution then fails below, the Lead still commits (self-healing: the next call from the same
  // number matches it normally); this never invents an assignment just to satisfy Call.agentId.
  const leadCreated = leads.length === 0;
  const lead = leads.length === 1 ? leads[0]! : await tx.createIvrLead(event.customerNumber);
  if (!lead) return { kind: "UNMATCHED", reason: "NO_LEAD_MATCH" };

  const agentId = await resolveAgentId(tx, event, lead.ownerId);
  // The Lead above has already committed (it's created inside the same transaction as everything
  // else here) even when this returns UNMATCHED - carrying its id through means the diagnostic log
  // below, and WebhookEvent reconciliation, both know a Lead exists even though no Call does yet.
  if (!agentId) return { kind: "UNMATCHED", reason: "NO_AGENT_RESOLVED", leadId: lead.id };

  const virtualNumberId = await tx.findVirtualNumberId(virtualNumberCandidates(event));
  return { kind: "CREATE", leadId: lead.id, agentId, virtualNumberId, leadCreated };
}

/**
 * Next Call status for an event, or undefined for "leave unchanged".
 *  - Call Report is authoritative and may override a provisional terminal status; an
 *    unrecognised report status becomes FAILED but never overwrites a known terminal one.
 *  - Live events only ever move a call forward and never overwrite a terminal status.
 */
function nextStatus(event: NormalizedCallEvent, current: CallStatus | undefined): CallStatus | undefined {
  if (event.eventType === "CALL_REPORT") {
    if (event.status !== null) return event.status;
    return current !== undefined && isTerminalCallStatus(current) ? undefined : CallStatus.FAILED;
  }

  if (event.status === null) return undefined;
  if (current === undefined) return event.status;
  if (isTerminalCallStatus(current)) return undefined;
  return callStatusRank(event.status) > callStatusRank(current) ? event.status : undefined;
}

function buildCallPatch(call: StoredCall, event: NormalizedCallEvent, status: CallStatus | undefined): CallPatch {
  const patch: CallPatch = {};

  if (call.providerCallId !== event.externalCallId) patch.providerCallId = event.externalCallId;
  if (status !== undefined && status !== call.status) patch.status = status;
  if (event.startedAt && !call.startedAt) patch.startedAt = event.startedAt;
  if (event.customerPickedAt && !call.answeredAt) patch.answeredAt = event.customerPickedAt;

  if (event.eventType === "CALL_REPORT") {
    if (event.endedAt) patch.endedAt = event.endedAt;
    if (event.talkDurationSeconds !== null) patch.durationSeconds = event.talkDurationSeconds;
  }

  return patch;
}

export function createCallerDeskWebhookService(store: CallEventStore, options: CallerDeskServiceOptions = {}) {
  const now = options.now ?? (() => new Date());

  async function handle(tx: CallEventTx, event: NormalizedCallEvent, receivedAt: Date): Promise<CallerDeskWebhookResult> {
    const provider = providerDbValue(event.provider);
    const eventType = eventTypeDbValue(event);

    await tx.lockCall(`${provider}:${event.externalCallId}`);

    const existing = event.dedupeKey
      ? await tx.findWebhookEvent({ provider, eventType, externalEventId: event.dedupeKey })
      : null;

    if (existing && (existing.status === WebhookStatus.PROCESSED || existing.status === WebhookStatus.IGNORED)) {
      return { outcome: "DUPLICATE", webhookEventId: existing.id };
    }

    const webhookEvent =
      existing ??
      (await tx.createWebhookEvent({
        provider,
        eventType,
        externalEventId: event.dedupeKey,
        payload: event.rawPayload,
        status: WebhookStatus.RECEIVED,
        receivedAt,
      }));

    // A Live event we cannot interpret carries no usable state: keep it, apply nothing.
    if (event.eventType === "LIVE_CALL" && event.status === null) {
      await tx.updateWebhookEvent(webhookEvent.id, {
        status: WebhookStatus.IGNORED,
        errorMessage: "UNRECOGNISED_LIVE_STATUS",
        processedAt: receivedAt,
      });
      return { outcome: "IGNORED", webhookEventId: webhookEvent.id, reason: "UNRECOGNISED_LIVE_STATUS" };
    }

    const correlation = await correlate(tx, event, provider);

    if (correlation.kind === "UNMATCHED") {
      // Left RECEIVED = "stored, awaiting correlation". Clear a stale FAILED marker on retry.
      if (existing && existing.status === WebhookStatus.FAILED) {
        await tx.updateWebhookEvent(webhookEvent.id, { status: WebhookStatus.RECEIVED, errorMessage: null });
      }
      return { outcome: "UNMATCHED", webhookEventId: webhookEvent.id, reason: correlation.reason, ...(correlation.leadId ? { leadId: correlation.leadId } : {}) };
    }

    let call: StoredCall;
    let callCreated = false;
    let method: CorrelationMethod;
    const leadCreated = correlation.kind === "CREATE" && correlation.leadCreated;

    if (correlation.kind === "CALL") {
      method = correlation.method;
      const status = nextStatus(event, correlation.call.status);
      const patch = buildCallPatch(correlation.call, event, status);
      call = Object.keys(patch).length > 0 ? await tx.updateCall(correlation.call.id, patch) : correlation.call;
    } else {
      method = "PHONE_NUMBER";
      const status = nextStatus(event, undefined) ?? CallStatus.FAILED;
      call = await tx.createCall({
        leadId: correlation.leadId,
        agentId: correlation.agentId,
        virtualNumberId: correlation.virtualNumberId,
        provider,
        providerCallId: event.externalCallId,
        direction: event.direction === "INBOUND" ? CallDirection.INBOUND : CallDirection.OUTBOUND,
        status,
        agentNumber: event.agentNumber,
        customerNumber: event.customerNumber,
        startedAt: event.startedAt,
        answeredAt: event.customerPickedAt,
        endedAt: event.eventType === "CALL_REPORT" ? event.endedAt : null,
        durationSeconds: event.eventType === "CALL_REPORT" ? event.talkDurationSeconds : null,
      });
      callCreated = true;
    }

    let recording: "created" | "updated" | "unchanged" | "none" = "none";
    if (event.eventType === "CALL_REPORT" && event.recordingUrl) {
      // The provider-hosted URL is stored as-is; it is not downloaded and not exposed by any endpoint.
      recording = await tx.upsertRecording({
        callId: call.id,
        recordingUrl: event.recordingUrl,
        storageProvider: provider,
        durationSeconds: event.talkDurationSeconds,
        status: "PROVIDER_HOSTED",
      });
    }

    let activityCreated = false;
    if (isTerminalCallStatus(call.status) && !(await tx.hasCallActivity(call.leadId, call.id))) {
      const direction = call.direction === CallDirection.INBOUND ? "Inbound" : "Outbound";
      await tx.createCallActivity({
        leadId: call.leadId,
        actorId: call.agentId,
        callId: call.id,
        title: `${direction} call - ${STATUS_LABELS[call.status]}`,
        description: call.durationSeconds !== null ? `Talk time ${call.durationSeconds}s` : null,
      });
      await tx.touchLead(call.leadId, {
        lastActivityAt: event.endedAt ?? receivedAt,
        ...(call.status === CallStatus.COMPLETED ? { lastContactedAt: event.endedAt ?? receivedAt } : {}),
      });
      activityCreated = true;
    }

    await tx.updateWebhookEvent(webhookEvent.id, {
      status: WebhookStatus.PROCESSED,
      errorMessage: null,
      processedAt: now(),
    });

    return {
      outcome: "PROCESSED",
      webhookEventId: webhookEvent.id,
      callId: call.id,
      leadId: call.leadId,
      leadCreated,
      correlation: method,
      callCreated,
      recording,
      activityCreated,
    };
  }

  async function processWebhook(body: unknown): Promise<CallerDeskWebhookResult> {
    const parsed = normalizeCallerDeskPayload(body, { timestampUtcOffset: options.timestampUtcOffset });
    if (!parsed.ok) {
      logger.warn(`CallerDesk webhook rejected: category=INVALID_PAYLOAD reason="${logToken(parsed.reason, 120)}"`);
      return { outcome: "INVALID", reason: parsed.reason };
    }

    const event = parsed.event;
    const receivedAt = now();

    if (event.status === null && event.rawStatus !== null) {
      logger.warn(
        `CallerDesk webhook: unrecognised status callSid=${logToken(event.externalCallId)} eventType=${event.eventType} rawStatus="${logToken(event.rawStatus, 40)}"`,
      );
    }

    try {
      const result = await store.transaction((tx) => handle(tx, event, receivedAt));

      logger.info(
        `CallerDesk webhook: provider=callerdesk eventType=${event.eventType} callSid=${logToken(event.externalCallId)} result=${result.outcome}` +
          (result.outcome === "PROCESSED"
            ? ` correlation=${result.correlation} callCreated=${result.callCreated} recording=${result.recording} activityCreated=${result.activityCreated}`
            : result.outcome === "UNMATCHED"
              ? ` reason=${result.reason}`
              : ""),
      );

      // Diagnostic-only, kept separate from the line above so its format stays stable: every safe
      // identifier needed to trace one inbound call end-to-end during UAT, without ever logging a
      // full phone number (see maskPhone) or the raw payload.
      if (event.direction === "INBOUND") {
        const leadFoundOrCreated =
          result.outcome === "PROCESSED"
            ? (result.leadCreated ? "CREATED" : "FOUND")
            : result.outcome === "UNMATCHED" && result.leadId
              ? "CREATED"
              : "NONE";
        const skipReason = result.outcome === "UNMATCHED" ? result.reason : result.outcome === "FAILED" ? "PROCESSING_FAILED" : "none";
        logger.info(
          `CallerDesk inbound diagnostic: callSid=${logToken(event.externalCallId)} direction=${event.direction} ` +
            `status=${logToken(event.rawStatus, 40)} campid=${logToken(event.campaignId)} ` +
            `sourceNumber=${maskPhone(event.customerNumber)} destinationNumber=${maskPhone(event.businessNumber ?? event.destinationNumber)} ` +
            `agentNumber=${maskPhone(event.agentNumber)} lead=${leadFoundOrCreated} ` +
            `leadId=${result.outcome === "PROCESSED" ? result.leadId : (result.outcome === "UNMATCHED" ? (result.leadId ?? "none") : "none")} ` +
            `callCreated=${result.outcome === "PROCESSED" ? String(result.callCreated) : "false"} ` +
            `callId=${result.outcome === "PROCESSED" ? result.callId : "none"} skipReason=${skipReason}`,
        );
      }

      return result;
    } catch (err) {
      // Only the error name is logged: DB errors can embed connection details.
      const category = err instanceof Error ? err.name : "UnknownError";
      logger.error(
        `CallerDesk webhook: provider=callerdesk eventType=${event.eventType} callSid=${logToken(event.externalCallId)} result=FAILED category=${logToken(category, 40)}`,
      );

      try {
        await store.recordFailure({
          provider: providerDbValue(event.provider),
          eventType: eventTypeDbValue(event),
          externalEventId: event.dedupeKey,
          payload: event.rawPayload,
          status: WebhookStatus.FAILED,
          errorMessage: `Processing failed (${logToken(category, 40)})`,
          receivedAt,
        });
      } catch {
        logger.error(`CallerDesk webhook: could not persist failed event callSid=${logToken(event.externalCallId)}`);
      }

      return { outcome: "FAILED" };
    }
  }

  return { processWebhook };
}

export type CallerDeskWebhookService = ReturnType<typeof createCallerDeskWebhookService>;
