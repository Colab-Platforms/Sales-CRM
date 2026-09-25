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
}

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
  /** Never the raw provider recording URL - that is not exposed by any endpoint (see the telephony README). */
  hasRecording: boolean;
  createdAt: Date;
}

export interface CallDetail extends CallListItem {
  answeredAt: Date | null;
  notes: string | null;
  callingIdentity: CallingIdentityRef | null;
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
