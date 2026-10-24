import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ReportAutomationConfig, ReportAutomationConfigInput, ReportAutomationStatus, ReportDelivery, ReportDeliveryPage, ReportPreview, ReportRecipientResult } from "../types/report-automation.types";

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
  async status(): Promise<ReportAutomationStatus> {
    return (await apiClient.get<ApiEnvelope<ReportAutomationStatus>>("/report-automation/status")).data.data;
  },
  /** Retry one recipient whose message definitely failed (never an accepted or unknown-outcome one). */
  async retry(recipientResultId: string, part: "TEXT" | "DETAIL" | "DOCUMENT" = "TEXT"): Promise<ReportRecipientResult> {
    return (await apiClient.post<ApiEnvelope<ReportRecipientResult>>(`/report-automation/deliveries/${recipientResultId}/retry`, { part })).data.data;
  },
  async deliveries(page = 1, pageSize = 20): Promise<ReportDeliveryPage> {
    return (await apiClient.get<ApiEnvelope<ReportDeliveryPage>>("/report-automation/deliveries", { params: { page, pageSize } })).data.data;
  },
};
