import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  BucketKind,
  BucketSummaryRow,
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  BulkUpdateStatusPayload,
  CreateLeadPayload,
  FileImportAnalysis,
  FileImportMappingResult,
  FileImportProgress,
  ImportBatchSummary,
  ImportPreviewResult,
  Lead,
  LeadAssignmentRecord,
  LeadListParams,
  LeadListResult,
  UpdateLeadPayload,
} from "../types/lead.types";

export const leadApi = {
  async listLeads(params: LeadListParams): Promise<LeadListResult> {
    const res = await apiClient.get<ApiEnvelope<LeadListResult>>("/lead/leads", { params });
    return res.data.data;
  },

  async getBucketSummary(kind: BucketKind = "LEAD"): Promise<BucketSummaryRow[]> {
    const res = await apiClient.get<ApiEnvelope<BucketSummaryRow[]>>("/lead/leads/bucket/summary", { params: { kind } });
    return res.data.data;
  },

  async getLead(id: string): Promise<Lead> {
    const res = await apiClient.get<ApiEnvelope<Lead>>(`/lead/leads/${id}`);
    return res.data.data;
  },

  async createLead(payload: CreateLeadPayload): Promise<Lead> {
    const res = await apiClient.post<ApiEnvelope<Lead>>("/lead/leads", payload);
    return res.data.data;
  },

  async updateLead(id: string, payload: UpdateLeadPayload): Promise<Lead> {
    const res = await apiClient.patch<ApiEnvelope<Lead>>(`/lead/leads/${id}`, payload);
    return res.data.data;
  },

  async deleteLead(id: string): Promise<{ id: string }> {
    const res = await apiClient.delete<ApiEnvelope<{ id: string }>>(`/lead/leads/${id}`);
    return res.data.data;
  },

  async getAssignmentHistory(id: string): Promise<LeadAssignmentRecord[]> {
    const res = await apiClient.get<ApiEnvelope<LeadAssignmentRecord[]>>(`/lead/leads/${id}/assignments`);
    return res.data.data;
  },

  async bulkAssignManager(payload: BulkAssignManagerPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>(
      "/lead/leads/bulk/assign-manager",
      payload,
      { timeout: 300_000 },
    );
    return res.data.data;
  },

  async bulkAssignSalesperson(payload: BulkAssignSalespersonPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>(
      "/lead/leads/bulk/assign-salesperson",
      payload,
      { timeout: 300_000 },
    );
    return res.data.data;
  },

  async bulkUpdateStatus(payload: BulkUpdateStatusPayload): Promise<{ updatedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ updatedCount: number }>>(
      "/lead/leads/bulk/update-status",
      payload,
    );
    return res.data.data;
  },

  async previewImport(file: File, columnMapping: Record<string, string>): Promise<ImportPreviewResult> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("columnMapping", JSON.stringify(columnMapping));
    const res = await apiClient.post<ApiEnvelope<ImportPreviewResult>>("/lead/leads/import/preview", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return res.data.data;
  },

  async confirmImport(batchId: string): Promise<{ batchId: string; createdCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ batchId: string; createdCount: number }>>(
      `/lead/leads/import/${batchId}/confirm`,
    );
    return res.data.data;
  },

  // ---- file import v2 (Excel / CSV)
  async analyzeImportFile(file: File, segmentId?: string): Promise<FileImportAnalysis> {
    const formData = new FormData();
    formData.append("file", file);
    if (segmentId) formData.append("segmentId", segmentId);
    const res = await apiClient.post<ApiEnvelope<FileImportAnalysis>>("/lead/leads/import/file", formData, { headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000 });
    return res.data.data;
  },

  async updateImportMapping(batchId: string, payload: { mapping?: Record<string, string>; segmentId?: string | null }): Promise<FileImportMappingResult> {
    const res = await apiClient.patch<ApiEnvelope<FileImportMappingResult>>(`/lead/leads/import/${batchId}/mapping`, payload, { timeout: 120_000 });
    return res.data.data;
  },

  async startImportFile(batchId: string, segmentId?: string | null): Promise<FileImportProgress> {
    const res = await apiClient.post<ApiEnvelope<FileImportProgress>>(`/lead/leads/import/${batchId}/start`, segmentId !== undefined ? { segmentId } : {});
    return res.data.data;
  },

  async getImportProgress(batchId: string): Promise<FileImportProgress> {
    const res = await apiClient.get<ApiEnvelope<FileImportProgress>>(`/lead/leads/import/${batchId}/progress`);
    return res.data.data;
  },

  /** The failed (or duplicate) rows with their reasons, as a CSV Blob the user can correct and re-upload. */
  async downloadImportReport(batchId: string, kind: "failed" | "duplicates"): Promise<Blob> {
    const res = await apiClient.get<Blob>(`/lead/leads/import/${batchId}/report`, { params: { kind }, responseType: "blob" });
    return res.data;
  },

  async getImportBatch(batchId: string): Promise<ImportBatchSummary> {
    const res = await apiClient.get<ApiEnvelope<ImportBatchSummary>>(`/lead/leads/import/${batchId}`);
    return res.data.data;
  },
};
