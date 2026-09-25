import { CallStatus, Role } from "@root/generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import { normalizePhone } from "@/utils/phone.js";
import { providerDbValue } from "@modules/telephony/provider.types.js";
import { TelephonyInitiationFailedError, type TelephonyService } from "@modules/telephony/telephony.service.js";
import type { InitiateCallErrorCode, InitiateCallRequest, InitiateCallResponse } from "@modules/telephony/call.contract.js";
import type { CallInitiationStore, LeadForCall } from "./call.store.js";

/**
 * `POST /api/calls` business logic. Flow (agent-first, two-leg call via the telephony provider):
 *
 *   authorise -> resolve customer number -> resolve agent number -> resolve business number
 *   -> create Call(INITIATED) atomically, refusing if a call is already active
 *   -> telephony.initiateOutboundCall (CallerDesk primary, Exotel only after a definitive NOT_DISPATCHED)
 *   -> record the provider id (campid) on the Call, or mark it FAILED
 *
 * Outcomes on provider failure:
 *   - certainly NOT placed  -> Call = FAILED, TELEPHONY_UNAVAILABLE (503, safe to retry)
 *   - possibly placed       -> Call stays INITIATED (the active-call guard then blocks blind retries
 *                              for ACTIVE_CALL_WINDOW_MINUTES), CALL_OUTCOME_UNKNOWN (502)
 */

/** A non-terminal Call not updated within this window no longer blocks new calls (its webhooks never arrived). */
export const ACTIVE_CALL_WINDOW_MINUTES = 15;

const HTTP: Record<InitiateCallErrorCode, number> = {
  INVALID_REQUEST: 400,
  LEAD_NOT_FOUND: 404,
  LEAD_PHONE_MISSING: 422,
  AGENT_PHONE_MISSING: 422,
  CALLING_IDENTITY_UNAVAILABLE: 422,
  CALL_ALREADY_IN_PROGRESS: 409,
  TELEPHONY_UNAVAILABLE: 503,
  CALL_OUTCOME_UNKNOWN: 502,
  INTERNAL_ERROR: 500,
};

export class CallInitiationError extends Error {
  readonly code: InitiateCallErrorCode;
  readonly httpStatus: number;
  readonly callId?: string;

  constructor(code: InitiateCallErrorCode, message: string, callId?: string) {
    super(message);
    this.name = "CallInitiationError";
    this.code = code;
    this.httpStatus = HTTP[code];
    this.callId = callId;
    Object.setPrototypeOf(this, CallInitiationError.prototype);
  }
}

export interface CallActor {
  id: string;
  role: Role;
}

/**
 * The CallerDesk click-to-call contract takes 10-digit numbers without a country code. Anything that
 * is not unambiguously an Indian 10-digit number (optionally with a leading 0 or 91) is refused
 * rather than truncated - truncating a foreign number would dial a stranger.
 */
export function toDialableNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");

  const isTen = digits.length === 10;
  const isTrunkPrefixed = digits.length === 11 && digits.startsWith("0");
  const isCountryPrefixed = digits.length === 12 && digits.startsWith("91");
  if (!isTen && !isTrunkPrefixed && !isCountryPrefixed) return null;

  const local = normalizePhone(digits);
  return local && local.length === 10 ? local : null;
}

/** Same visibility rules as lead.service.ts: ADMIN any lead; MANAGER their own; SALESPERSON their own. */
export function canAccessLead(actor: CallActor, lead: LeadForCall): boolean {
  if (actor.role === Role.ADMIN) return true;
  if (actor.role === Role.MANAGER) return lead.assignedManagerId === actor.id;
  if (actor.role === Role.SALESPERSON) return lead.ownerId === actor.id;
  return false;
}

export interface CallServiceDeps {
  store: CallInitiationStore;
  telephony: Pick<TelephonyService, "initiateOutboundCall">;
  now?: () => Date;
}

export function createCallService({ store, telephony, now = () => new Date() }: CallServiceDeps) {
  async function initiateCall(actor: CallActor, request: InitiateCallRequest): Promise<InitiateCallResponse> {
    const lead = await store.findLead(request.leadId);
    // Unknown lead and inaccessible lead are indistinguishable to the caller.
    if (!lead || !canAccessLead(actor, lead)) {
      throw new CallInitiationError("LEAD_NOT_FOUND", "Lead not found");
    }

    const customerNumber = toDialableNumber(lead.normalizedMobile ?? lead.mobile);
    if (!customerNumber) {
      throw new CallInitiationError("LEAD_PHONE_MISSING", "This lead has no phone number that can be called");
    }

    const agent = await store.findAgent(actor.id);
    const agentNumber = agent && agent.isActive ? toDialableNumber(agent.phone) : null;
    if (!agent || !agentNumber) {
      throw new CallInitiationError("AGENT_PHONE_MISSING", "Add a valid phone number to your profile before calling");
    }

    const identity = await store.findCallingIdentity(lead.groupId);
    if (!identity) {
      throw new CallInitiationError("CALLING_IDENTITY_UNAVAILABLE", "No business calling number is configured for this lead");
    }

    const activeSince = new Date(now().getTime() - ACTIVE_CALL_WINDOW_MINUTES * 60_000);
    const created = await store.createCallUnlessActive(
      {
        leadId: lead.id,
        agentId: agent.id,
        virtualNumberId: identity.virtualNumberId,
        provider: providerDbValue("CALLERDESK"),
        agentNumber,
        customerNumber,
      },
      activeSince,
    );
    if (!created.created) {
      throw new CallInitiationError("CALL_ALREADY_IN_PROGRESS", "A call is already in progress", created.activeCallId);
    }
    const callId = created.callId;

    let outcome: Awaited<ReturnType<TelephonyService["initiateOutboundCall"]>>;
    try {
      outcome = await telephony.initiateOutboundCall({
        callId,
        leadId: lead.id,
        agentNumber,
        customerNumber,
        businessNumber: identity.number,
      });
    } catch (err) {
      const mayHaveBeenPlaced = !(err instanceof TelephonyInitiationFailedError) || err.callMayHaveBeenPlaced;
      const attempts = err instanceof TelephonyInitiationFailedError ? err.attempts.map((a) => `${a.provider}:${a.kind}:${a.code}`).join(",") : "unexpected";

      if (mayHaveBeenPlaced) {
        logger.warn(`Call initiation: callId=${callId} result=OUTCOME_UNKNOWN attempts=${attempts}`);
        throw new CallInitiationError("CALL_OUTCOME_UNKNOWN", "The call could not be confirmed. Check your phone before trying again", callId);
      }

      await store.markFailed(callId).catch(() => logger.error(`Call initiation: could not mark callId=${callId} FAILED`));
      logger.warn(`Call initiation: callId=${callId} result=NOT_DISPATCHED attempts=${attempts}`);
      throw new CallInitiationError("TELEPHONY_UNAVAILABLE", "Calling is temporarily unavailable. Please try again", callId);
    }

    // The provider accepted the call: from here a failure to record it must NOT fail the request.
    try {
      await store.markInitiated(callId, { provider: providerDbValue(outcome.result.provider), providerCallId: outcome.result.providerCallId });
    } catch {
      logger.error(
        `Call initiation: accepted but could not store provider id callId=${callId} provider=${outcome.result.provider} providerCallId=${outcome.result.providerCallId ?? "none"}`,
      );
    }
    if (!outcome.result.providerCallId) {
      logger.warn(`Call initiation: provider accepted callId=${callId} without a provider call id; webhooks cannot be correlated`);
    }
    logger.info(`Call initiation: callId=${callId} result=INITIATED provider=${outcome.result.provider} fallbackUsed=${outcome.fallbackUsed}`);

    return {
      callId,
      status: CallStatus.INITIATED,
      callingIdentity: { displayName: identity.displayName, number: identity.number },
    };
  }

  return { initiateCall };
}

export type CallService = ReturnType<typeof createCallService>;
