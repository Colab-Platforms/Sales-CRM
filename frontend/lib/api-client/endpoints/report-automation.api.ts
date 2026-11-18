import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ReportAutomationConfig, ReportAutomationConfigInput, ReportAutomationStatus, ReportDelivery, ReportDeliveryPage, ReportPreview, ReportRecipientResult, ReportScheduled, ReportTracking } from "../types/report-automation.types";

/** One APPROVED template as Meta reports it, for the Add Template picker. */
export interface ApprovedMetaTemplate {
  name: string;
  language: string;
  category: string | null;
  variables: string[];
  alreadyAdded: boolean;
  /** false = the report's sender cannot use it (wrong name family or variables); `incompatibleReason` says why. */
  compatible: boolean;
  incompatibleReason: string | null;
}
export const APPROVED_LIST_TIMEOUT_MS = 30_000;

// Admin / Manager only on the server; every call is authenticated like the rest of the CRM.
export const reportAutomationApi = {
  async getConfig(): Promise<ReportAutomationConfig> {
    return (await apiClient.get<ApiEnvelope<ReportAutomationConfig>>("/report-automation/config")).data.data;
  },
  async saveConfig(input: ReportAutomationConfigInput): Promise<ReportAutomationConfig> {
    return (await apiClient.put<ApiEnvelope<ReportAutomationConfig>>("/report-automation/config", input)).data.data;
  },
  async preview(date?: string): Promise<ReportPreview> {
    return (await apiClient.get<ApiEnvelope<ReportPreview>>("/report-automation/preview", { params: date ? { date } : {} })).data.data;
  },
  async testSend(recipientIds?: string[]): Promise<ReportDelivery> {
    return (await apiClient.post<ApiEnvelope<ReportDelivery>>("/report-automation/test-send", { confirm: true, ...(recipientIds ? { recipientIds } : {}) })).data.data;
  },
  /** Admin only: cancel one upcoming occurrence (durable; the scheduler will not send it). */
  async cancelScheduled(occurrenceDate: string): Promise<{ runId: string }> {
    return (await apiClient.post<ApiEnvelope<{ runId: string }>>("/report-automation/scheduled/cancel", { occurrenceDate })).data.data;
  },
  /** Admin only: hide a finished run from the history (soft delete; sent messages are not recalled). */
  async deleteRun(id: string): Promise<void> {
    await apiClient.delete(`/report-automation/deliveries/${id}`);
  },
  /** Pause (false) / resume (true) the recurring automation - the same `enabled` setting as the form. */
  async setEnabled(enabled: boolean): Promise<void> {
    await apiClient.put("/report-automation/enabled", { enabled });
  },
  async scheduled(): Promise<ReportScheduled> {
    return (await apiClient.get<ApiEnvelope<ReportScheduled>>("/report-automation/scheduled")).data.data;
  },
  /** Live delivery + reply status of one run (default: the latest). Polled by the page. */
  async tracking(runId?: string): Promise<ReportTracking> {
    return (await apiClient.get<ApiEnvelope<ReportTracking>>("/report-automation/tracking", { params: runId ? { runId } : {} })).data.data;
  },
  async status(): Promise<ReportAutomationStatus> {
    return (await apiClient.get<ApiEnvelope<ReportAutomationStatus>>("/report-automation/status")).data.data;
  },
  /** Retry one recipient whose message definitely failed (never an accepted or unknown-outcome one). */
  async retry(recipientResultId: string, part: "TEXT" | "DETAIL" | "DOCUMENT" = "TEXT"): Promise<ReportRecipientResult> {
    return (await apiClient.post<ApiEnvelope<ReportRecipientResult>>(`/report-automation/deliveries/${recipientResultId}/retry`, { part })).data.data;
  },
  /** Admin only: Meta's live list of APPROVED templates (read-only; one attempt, gives up after 30s). */
  async approvedTemplates(): Promise<ApprovedMetaTemplate[]> {
    return (await apiClient.get<ApiEnvelope<ApprovedMetaTemplate[]>>("/report-automation/templates/approved", { timeout: APPROVED_LIST_TIMEOUT_MS })).data.data;
  },
  /** Admin only: register one of those templates in the CRM (the server re-checks it against Meta's list). */
  async addTemplate(name: string, language: string): Promise<{ alreadyAdded: boolean; name: string; language: string }> {
    return (await apiClient.post<ApiEnvelope<{ alreadyAdded: boolean; name: string; language: string }>>("/report-automation/templates/add", { name, language }, { timeout: APPROVED_LIST_TIMEOUT_MS })).data.data;
  },
  /** One entry per report RUN (recipients nested), newest first. `status` and `date` (YYYY-MM-DD: data date or send day) filter on the server. */
  async deliveries(page = 1, pageSize = 20, filters: { status?: "SENT" | "FAILED" | "PENDING" | "CANCELLED"; date?: string } = {}): Promise<ReportDeliveryPage> {
    return (await apiClient.get<ApiEnvelope<ReportDeliveryPage>>("/report-automation/deliveries", { params: { page, pageSize, ...(filters.status ? { status: filters.status } : {}), ...(filters.date ? { date: filters.date } : {}) } })).data.data;
  },
};
