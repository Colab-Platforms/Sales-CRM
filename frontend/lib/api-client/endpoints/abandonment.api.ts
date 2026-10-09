import { apiClient } from "../client";
import { encodeItemKeys, type ItemOption } from "../../abandonment-items";
import type { ApiEnvelope } from "../types/common.types";
import type {
  AbandonmentDetail,
  AutoAssignConfig,
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  BulkUpdateLeadStatusPayload,
  CreateRecoveryActionInput,
  ListAbandonmentsParams,
  ListAbandonmentsResult,
  ManagerAutoAssignConfig,
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

  async bulkAssignSalesperson(payload: BulkAssignSalespersonPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>("/abandonments/bulk/assign-salesperson", payload);
    return res.data.data;
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
};
