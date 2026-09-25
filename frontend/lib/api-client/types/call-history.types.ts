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
  /** Whether a recording exists — never the raw provider URL (not exposed by any endpoint). */
  hasRecording: boolean;
  createdAt: string;
}

export interface CallDetail extends CallListItem {
  answeredAt: string | null;
  notes: string | null;
  callingIdentity: CallingIdentity | null;
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
}
