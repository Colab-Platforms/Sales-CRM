/**
 * Mirrors backend/src/modules/telephony/call.contract.ts exactly. The frontend only ever talks to
 * `POST /api/calls` — never directly to any telephony provider — and this file is the sole source
 * of truth for that contract's shape on this side.
 */

/**
 * Backend `CallStatus` (generated/prisma/enums.ts), reproduced here since the frontend has no
 * access to the backend's generated Prisma types. `POST /api/calls` only ever returns "INITIATED"
 * on success today — the rest exist so this type doesn't need to change once a later step adds
 * webhook-driven live status (see components/calling/call-status-card.tsx).
 */
export type CallStatus =
  | "INITIATED"
  | "RINGING_AGENT"
  | "AGENT_ANSWERED"
  | "RINGING_CUSTOMER"
  | "CONNECTED"
  | "COMPLETED"
  | "NO_ANSWER"
  | "BUSY"
  | "NOT_REACHABLE"
  | "FAILED";

export interface CallingIdentity {
  displayName: string | null;
  number: string;
}

/** 201 response body. */
export interface InitiateCallResult {
  callId: string;
  status: CallStatus;
  callingIdentity: CallingIdentity;
}

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

/** The `data` payload of an error envelope (`{ success:false, message, data }`). */
export interface InitiateCallErrorData {
  code: InitiateCallErrorCode;
  callId?: string;
}
