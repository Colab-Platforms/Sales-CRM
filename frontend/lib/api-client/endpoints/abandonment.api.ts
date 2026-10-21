import { apiClient } from "../client";
import { encodeItemKeys, type ItemOption } from "../../abandonment-items";
import type { ApiEnvelope } from "../types/common.types";
import type { ImportPreviewResult } from "../types/lead.types";
import type {
  AbandonmentDetail,
  AutoAssignConfig,
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  BulkUpdateLeadStatusPayload,
  CreateRecoveryActionInput,
  ListAbandonmentsParams,
  ListAbandonmentsResult,
  AbandonmentDateRange,
  AbandonmentDistribution,
  AssignableTelecaller,
  IngestionReconcileResult,
  IngestionStatus,
  ManagerAutoAssignConfig,
  OrderPrefill,
  TelecallerSummary,
} from "../types/abandonment.types";

// `items` travels as one comma list of URL-encoded keys (a product name may itself contain commas); axios drops undefined params,
// so unset filters never reach the URL.
const wireParams = ({ items, ...rest }: ListAbandonmentsParams) => ({ ...rest, items: items && items.length > 0 ? encodeItemKeys(items) : undefined });

export const abandonmentApi = {
  async list(params: ListAbandonmentsParams): Promise<ListAbandonmentsResult> {
    const res = await apiClient.get<ApiEnvelope<ListAbandonmentsResult>>("/abandonments", { params: wireParams(params) });
    return res.data.data;
  },

  /** The products found in the viewer's abandoned carts (real data), for the Items filter. */
  async listItems(): Promise<{ items: ItemOption[] }> {
    const res = await apiClient.get<ApiEnvelope<{ items: ItemOption[] }>>("/abandonments/items");
    return res.data.data;
  },

  /** Ids of EVERY abandonment the filters match (not just this page), for "Select all". */
  async listMatchingIds(params: Omit<ListAbandonmentsParams, "page" | "pageSize">): Promise<{ ids: string[]; total: number; capped: boolean }> {
    const res = await apiClient.get<ApiEnvelope<{ ids: string[]; total: number; capped: boolean }>>("/abandonments/ids", { params: wireParams({ page: 1, pageSize: 25, ...params }) });
    return res.data.data;
  },

  /** The saved cart + address of this one abandoned checkout, for the Create Order form. */
  async orderPrefill(id: string): Promise<OrderPrefill> {
    const res = await apiClient.get<ApiEnvelope<OrderPrefill>>(`/abandonments/${id}/order-prefill`);
    return res.data.data;
  },

  async get(id: string): Promise<AbandonmentDetail> {
    const res = await apiClient.get<ApiEnvelope<AbandonmentDetail>>(`/abandonments/${id}`);
    return res.data.data;
  },

  async getByLead(leadId: string): Promise<AbandonmentDetail | null> {
    const res = await apiClient.get<ApiEnvelope<AbandonmentDetail | null>>(`/abandonments/by-lead/${leadId}`);
    return res.data.data;
  },

  async logRecoveryAction(id: string, input: CreateRecoveryActionInput): Promise<void> {
    await apiClient.post<ApiEnvelope<unknown>>(`/abandonments/${id}/recovery-actions`, input);
  },

  async bulkAssignManager(payload: BulkAssignManagerPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>("/abandonments/bulk/assign-manager", payload);
    return res.data.data;
  },

  async bulkAssignSalesperson(payload: BulkAssignSalespersonPayload): Promise<{ assignedCount: number; unchangedCount?: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number; unchangedCount?: number }>>("/abandonments/bulk/assign-salesperson", payload);
    return res.data.data;
  },

  /** Lead distribution by telecaller for a period (admin / manager / HR). */
  async distribution(range: AbandonmentDateRange): Promise<AbandonmentDistribution> {
    const res = await apiClient.get<ApiEnvelope<AbandonmentDistribution>>("/abandonments/distribution", { params: { dateRange: range } });
    return res.data.data;
  },

  /** The signed-in telecaller's own workload (the server derives who that is). */
  async mySummary(): Promise<TelecallerSummary> {
    const res = await apiClient.get<ApiEnvelope<TelecallerSummary>>("/abandonments/my-summary");
    return res.data.data;
  },

  /** Health of the Fastrr ingestion (admin / manager / HR). */
  async ingestionStatus(period: AbandonmentDateRange): Promise<IngestionStatus> {
    const res = await apiClient.get<ApiEnvelope<IngestionStatus>>("/abandonments/ingestion/status", { params: { period } });
    return res.data.data;
  },

  /** Re-process deliveries that failed for good (admin only; bounded; recovered leads are never auto-assigned). */
  async reconcileIngestion(): Promise<IngestionReconcileResult> {
    const res = await apiClient.post<ApiEnvelope<IngestionReconcileResult>>("/abandonments/ingestion/reconcile", {});
    return res.data.data;
  },

  /** Telecallers the viewer may assign leads to (everyone for admin / HR, the team for a manager). */
  async telecallers(): Promise<AssignableTelecaller[]> {
    const res = await apiClient.get<ApiEnvelope<{ telecallers: AssignableTelecaller[] }>>("/abandonments/telecallers");
    return res.data.data.telecallers;
  },

  async bulkUpdateLeadStatus(payload: BulkUpdateLeadStatusPayload): Promise<{ updatedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ updatedCount: number }>>("/abandonments/bulk/update-lead-status", payload);
    return res.data.data;
  },

  async getManagerAutoAssignConfig(): Promise<ManagerAutoAssignConfig> {
    const res = await apiClient.get<ApiEnvelope<ManagerAutoAssignConfig>>("/abandonments/auto-assign/manager-config");
    return res.data.data;
  },

  /** `managerIds` omitted leaves the stored selection untouched (e.g. a plain "turn off"); pass it
   *  whenever the admin just picked/changed the set of managers. */
  async setManagerAutoAssignConfig(enabled: boolean, managerIds?: string[]): Promise<ManagerAutoAssignConfig> {
    const res = await apiClient.patch<ApiEnvelope<ManagerAutoAssignConfig>>("/abandonments/auto-assign/manager-config", { enabled, managerIds });
    return res.data.data;
  },

  async getSalespersonAutoAssignConfig(): Promise<AutoAssignConfig> {
    const res = await apiClient.get<ApiEnvelope<AutoAssignConfig>>("/abandonments/auto-assign/salesperson-config");
    return res.data.data;
  },

  async setSalespersonAutoAssignConfig(enabled: boolean): Promise<AutoAssignConfig> {
    const res = await apiClient.patch<ApiEnvelope<AutoAssignConfig>>("/abandonments/auto-assign/salesperson-config", { enabled });
    return res.data.data;
  },

  async previewImport(file: File, columnMapping: Record<string, string>): Promise<ImportPreviewResult> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("columnMapping", JSON.stringify(columnMapping));
    const res = await apiClient.post<ApiEnvelope<ImportPreviewResult>>("/abandonments/import/preview", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return res.data.data;
  },

  async confirmImport(batchId: string): Promise<{ batchId: string; createdCount: number; failedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ batchId: string; createdCount: number; failedCount: number }>>(`/abandonments/import/${batchId}/confirm`);
    return res.data.data;
  },
};
