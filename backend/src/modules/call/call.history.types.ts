import type { CallDirection, CallStatus } from "../../../generated/prisma/enums.js";

/**
 * `GET /api/calls` / `GET /api/calls/:id` — read-only reporting over the existing `Call` table and
 * its relations. Never touches `activity.findMany()` (see call.history.service.ts's header comment).
 *
 * Field names/shape are dictated by the already-built frontend contract
 * (frontend/lib/api-client/types/call-history.types.ts) - this file mirrors it exactly rather than
 * inventing a divergent backend shape.
 */

export interface ListCallsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: CallStatus;
  direction?: CallDirection;
  dateFrom?: Date;
  dateTo?: Date;
  /** IVR reporting filters - optional, additive to the plain Call History page's existing filters. */
  agentId?: string;
  virtualNumberId?: string;
  hasRecording?: boolean;
}

/** Same filters as the list, minus pagination - shared by `GET /api/calls/summary`. */
export type CallSummaryQuery = Omit<ListCallsQuery, "page" | "limit">;

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

export interface CallingIdentityRef {
  displayName: string | null;
  number: string;
}

export interface CallListItem {
  id: string;
  lead: CallLeadRef;
  agent: CallAgentRef;
  direction: CallDirection;
  status: CallStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  outcome: CallOutcomeRef | null;
  /** Never the raw provider recording URL in the list - that stays detail-only and role-gated. */
  hasRecording: boolean;
  createdAt: Date;
  /** Raw numbers as dialled/received (IVR reporting columns: "Caller" / "Customer"). */
  agentNumber: string | null;
  customerNumber: string | null;
  virtualNumber: CallingIdentityRef | null;
  /** CallerDesk CallSid once known (set at webhook correlation, or at initiation before that). */
  providerCallId: string | null;
}

/** Safe-only fields pulled from the correlated CallerDesk Call Report webhook payload for display.
 * Never the raw payload, never a credential - see call.history.metadata.ts for the exact allowlist. */
export interface CallProviderMetadata {
  campaignId: string | null;
  errorCode: string | null;
  callGroup: string | null;
  receiverName: string | null;
  agentPickedAt: string | null;
  customerLegStartedAt: string | null;
  customerPickedAt: string | null;
  /** CallerDesk's "CallDuration" (full ring+talk time) - distinct from `durationSeconds`, which is
   * always "TalkDuration". See call.history.metadata.ts. */
  callDurationSeconds: number | null;
}

export interface CallDetail extends CallListItem {
  answeredAt: Date | null;
  notes: string | null;
  callingIdentity: CallingIdentityRef | null;
  /** Role-gated exactly like the legacy /api/calling recording field: null for SALESPERSON even when a recording exists. */
  recordingUrl: string | null;
  providerMetadata: CallProviderMetadata | null;
}

export interface CallStatusCount {
  status: CallStatus;
  count: number;
}

export interface CallSummary {
  total: number;
  byStatus: CallStatusCount[];
  totalTalkTimeSeconds: number;
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
