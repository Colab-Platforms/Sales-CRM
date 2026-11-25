import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { Pagination } from "../types/orders.types";
import type { LeadWorkingStatus } from "../types/dashboard.types";
import { abandonmentRecordingsApi, type RecordingExport, type RecordingExportKind } from "./abandonment.recordings.api";

// The Call Recordings screen of the Abandoned Leads module. Admin / manager only - the server enforces it; the UI merely does not offer the page to anyone else.

/** What the screen's filters have chosen. Days are IST calendar days (YYYY-MM-DD); the server filters and paginates everything. */
export interface CallRecordingFilterState {
  from: string;
  to: string;
  telecallerIds: string[];
  customer: string;
  mobile: string;
  /** Item keys of the products (same keys as the Abandoned Leads Items filter). */
  items: string[];
  statuses: LeadWorkingStatus[];
  /** "outcome:<id>" or "status:<CALL_STATUS>". */
  outcomes: string[];
  minDuration?: number;
  maxDuration?: number;
  leadId?: string;
  sort: "latest" | "oldest";
}

export interface CallRecordingItem {
  callId: string;
  callAt: string;
  leadId: string;
  abandonmentId: string | null;
  leadNumber: string;
  customerName: string;
  mobile: string | null;
  telecaller: { id: string; name: string };
  products: string[];
  leadStatus: LeadWorkingStatus;
  outcome: string;
  durationSeconds: number | null;
  /** Null when the recording cannot be played (see unavailableReason). */
  playUrl: string | null;
  unavailableReason: string | null;
}

export interface CallRecordingList {
  items: CallRecordingItem[];
  pagination: Pagination;
}

export interface CallRecordingSummary {
  totalRecordings: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number;
  telecallers: number;
  todayRecordings: number;
}

export interface CallRecordingOptions {
  telecallers: { id: string; name: string }[];
  outcomes: { value: string; label: string }[];
  leadStatuses: { value: LeadWorkingStatus; label: string }[];
}

/** The filters as the API takes them (query string for the list, the same names in an export body). Empty values are dropped. */
export function toFilterParams(f: CallRecordingFilterState): Record<string, string> {
  const out: Record<string, string> = { from: f.from, to: f.to, sort: f.sort };
  if (f.telecallerIds.length) out.telecallerIds = f.telecallerIds.join(",");
  if (f.customer.trim()) out.customer = f.customer.trim();
  if (f.mobile.trim()) out.mobile = f.mobile.trim();
  if (f.items.length) out.items = f.items.map(encodeURIComponent).join(",");
  if (f.statuses.length) out.statuses = f.statuses.join(",");
  if (f.outcomes.length) out.outcomes = f.outcomes.join(",");
  if (f.minDuration !== undefined) out.minDuration = String(f.minDuration);
  if (f.maxDuration !== undefined) out.maxDuration = String(f.maxDuration);
  if (f.leadId) out.leadId = f.leadId;
  return out;
}

export const callRecordingsApi = {
  async list(filters: CallRecordingFilterState, page: number, pageSize: number): Promise<CallRecordingList> {
    const res = await apiClient.get<ApiEnvelope<CallRecordingList>>("/abandonments/call-recordings", { params: { ...toFilterParams(filters), page, pageSize } });
    return res.data.data;
  },

  async summary(filters: CallRecordingFilterState): Promise<CallRecordingSummary> {
    const res = await apiClient.get<ApiEnvelope<CallRecordingSummary>>("/abandonments/call-recordings/summary", { params: toFilterParams(filters) });
    return res.data.data;
  },

  async options(): Promise<CallRecordingOptions> {
    const res = await apiClient.get<ApiEnvelope<CallRecordingOptions>>("/abandonments/call-recordings/options");
    return res.data.data;
  },

  /**
   * Starts a background ZIP / Excel export through the existing export machinery. `callIds` = exactly the ticked recordings; without it, everything the filters match.
   * Both follow the filters strictly (the server re-validates them and the viewer's scope).
   */
  startExport(kind: RecordingExportKind, filters: CallRecordingFilterState, callIds?: string[]): Promise<RecordingExport> {
    const callRecordings: Record<string, unknown> = { ...toFilterParams(filters), ...(callIds && callIds.length > 0 ? { callIds } : {}) };
    return abandonmentRecordingsApi.startExport({ kind, from: filters.from, to: filters.to, filters: { callRecordings } });
  },
};
