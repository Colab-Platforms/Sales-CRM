import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  CreateLeadPayload,
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

  async getAssignmentHistory(id: string): Promise<LeadAssignmentRecord[]> {
    const res = await apiClient.get<ApiEnvelope<LeadAssignmentRecord[]>>(`/lead/leads/${id}/assignments`);
    return res.data.data;
  },

  async bulkAssignManager(payload: BulkAssignManagerPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>(
      "/lead/leads/bulk/assign-manager",
      payload,
    );
    return res.data.data;
  },

  async bulkAssignSalesperson(payload: BulkAssignSalespersonPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>(
      "/lead/leads/bulk/assign-salesperson",
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

  async getImportBatch(batchId: string): Promise<ImportBatchSummary> {
    const res = await apiClient.get<ApiEnvelope<ImportBatchSummary>>(`/lead/leads/import/${batchId}`);
    return res.data.data;
  },
};
