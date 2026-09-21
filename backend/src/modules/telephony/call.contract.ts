import { z } from "zod";
import type { CallStatus } from "@root/generated/prisma/enums.js";

/**
 * `POST /api/calls` - provider-neutral contract.
 *
 * No field, status or error code reveals whether CallerDesk or Exotel handled the call, and no
 * provider response, message or identifier is ever passed through to the frontend.
 */

export const initiateCallRequestSchema = z.object({
  leadId: z.string().uuid(),
});

export type InitiateCallRequest = z.infer<typeof initiateCallRequestSchema>;

/** 201 Created. `status` is our internal CallStatus (INITIATED); later states arrive via webhooks. */
export interface InitiateCallResponse {
  callId: string;
  status: CallStatus;
  /** The business number / CLI the customer will see. */
  callingIdentity: { displayName: string | null; number: string };
}

/**
 * Stable, provider-neutral error codes. Error responses are
 * `{ success:false, message, data:{ code, callId? } }`.
 *
 * | code                          | HTTP | meaning |
 * |-------------------------------|------|---------|
 * | INVALID_REQUEST               | 400  | body failed validation |
 * | LEAD_NOT_FOUND                | 404  | no such lead, OR the caller may not access it (no existence leak) |
 * | LEAD_PHONE_MISSING            | 422  | the lead has no dialable number |
 * | AGENT_PHONE_MISSING           | 422  | the caller's own phone (which rings first) is missing/invalid |
 * | CALLING_IDENTITY_UNAVAILABLE  | 422  | no active business number configured for this lead |
 * | CALL_ALREADY_IN_PROGRESS      | 409  | an active call already exists for this lead or agent (`callId` = that call) |
 * | TELEPHONY_UNAVAILABLE         | 503  | the call was certainly NOT placed (safe to retry) |
 * | CALL_OUTCOME_UNKNOWN          | 502  | the provider did not confirm; a call MAY be ringing - do not auto-retry |
 */
export type InitiateCallErrorCode =
  | "INVALID_REQUEST"
  | "LEAD_NOT_FOUND"
  | "LEAD_PHONE_MISSING"
  | "AGENT_PHONE_MISSING"
  | "CALLING_IDENTITY_UNAVAILABLE"
  | "CALL_ALREADY_IN_PROGRESS"
  | "TELEPHONY_UNAVAILABLE"
  | "CALL_OUTCOME_UNKNOWN"
  | "INTERNAL_ERROR";
