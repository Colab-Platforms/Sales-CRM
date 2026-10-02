import type { CallingIdentity, CallStatus } from "./calls.types";

/**
 * Types for the Call History feature, matching `GET /api/calls` / `GET /api/calls/:id` on the
 * backend (backend/src/modules/call/call.history.types.ts) exactly. Modelled directly on the real
 * `Call`/`CallOutcome`/`CallRecording`/`VirtualNumber` Prisma models — not invented fields. Never a
 * raw recording URL: `hasRecording` is an indicator only, matching what the backend selects.
 */

export type CallDirection = "INBOUND" | "OUTBOUND";

export interface CallLeadRef {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  mobile: string | null;
}

export interface CallAgentRef {
  id: string;
  name: string;
}

export interface CallOutcomeRef {
  name: string;
  category: string;
}

export interface CallVirtualNumberRef {
  displayName: string | null;
  number: string;
}

export interface CallListItem {
  id: string;
  lead: CallLeadRef;
  agent: CallAgentRef;
  direction: CallDirection;
  status: CallStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  outcome: CallOutcomeRef | null;
  /** Whether a recording exists in the list — never the raw provider URL (that's detail-only, role-gated). */
  hasRecording: boolean;
  createdAt: string;
  /** Raw numbers as dialled/received (IVR reporting columns: "Caller" / "Customer"). */
  agentNumber: string | null;
  customerNumber: string | null;
  virtualNumber: CallVirtualNumberRef | null;
  /** CallerDesk CallSid once known. */
  providerCallId: string | null;
}

/** Safe-only fields read back from the stored CallerDesk Call Report webhook payload for display -
 * never a raw payload dump, never a credential. See backend call.history.metadata.ts. */
export interface CallProviderMetadata {
  campaignId: string | null;
  errorCode: string | null;
  callGroup: string | null;
  receiverName: string | null;
  agentPickedAt: string | null;
  customerLegStartedAt: string | null;
  customerPickedAt: string | null;
  /** CallerDesk's "CallDuration" (full ring+talk time) - distinct from `durationSeconds` (talk time only). */
  callDurationSeconds: number | null;
}

export interface CallDetail extends CallListItem {
  answeredAt: string | null;
  notes: string | null;
  callingIdentity: CallingIdentity | null;
  /** Role-gated: null for SALESPERSON even when a recording exists, same rule as the legacy /api/calling endpoint. */
  recordingUrl: string | null;
  providerMetadata: CallProviderMetadata | null;
}

export interface CallListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CallListResult {
  data: CallListItem[];
  pagination: CallListPagination;
}

export interface CallListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: CallStatus;
  direction?: CallDirection;
  // ISO dates (yyyy-mm-dd)
  dateFrom?: string;
  dateTo?: string;
  /** IVR reporting filters - additive, the plain Call History page just never sets them. */
  agentId?: string;
  virtualNumberId?: string;
  hasRecording?: boolean;
}

export type CallSummaryParams = Omit<CallListParams, "page" | "limit">;

export interface CallStatusCount {
  status: CallStatus;
  count: number;
}

export interface CallSummary {
  total: number;
  byStatus: CallStatusCount[];
  totalTalkTimeSeconds: number;
}
