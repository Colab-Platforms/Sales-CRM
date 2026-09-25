import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  Call,
  CallOutcomeOption,
  SubmitCallOutcomePayload,
  VirtualNumber,
  VirtualNumberRecord,
  CreateVirtualNumberPayload,
  UpdateVirtualNumberPayload,
} from "../types/calling.types";

export const callingApi = {
  async listVirtualNumbers(): Promise<VirtualNumber[]> {
    const res = await apiClient.get<ApiEnvelope<VirtualNumber[]>>("/calling/virtual-numbers");
    return res.data.data;
  },

  async listAllVirtualNumbers(): Promise<VirtualNumberRecord[]> {
    const res = await apiClient.get<ApiEnvelope<VirtualNumberRecord[]>>("/calling/virtual-numbers/all");
    return res.data.data;
  },

  async createVirtualNumber(payload: CreateVirtualNumberPayload): Promise<VirtualNumberRecord> {
    const res = await apiClient.post<ApiEnvelope<VirtualNumberRecord>>("/calling/virtual-numbers", payload);
    return res.data.data;
  },

  async updateVirtualNumber(id: string, payload: UpdateVirtualNumberPayload): Promise<VirtualNumberRecord> {
    const res = await apiClient.patch<ApiEnvelope<VirtualNumberRecord>>(`/calling/virtual-numbers/${id}`, payload);
    return res.data.data;
  },

  async deleteVirtualNumber(id: string): Promise<void> {
    await apiClient.delete(`/calling/virtual-numbers/${id}`);
  },

  async listLeadCalls(leadId: string): Promise<Call[]> {
    const res = await apiClient.get<ApiEnvelope<Call[]>>(`/calling/leads/${leadId}/calls`);
    return res.data.data;
  },

  async listCallOutcomes(): Promise<CallOutcomeOption[]> {
    const res = await apiClient.get<ApiEnvelope<CallOutcomeOption[]>>("/calling/call-outcomes");
    return res.data.data;
  },

  async submitCallOutcome(callId: string, payload: SubmitCallOutcomePayload): Promise<Call> {
    const res = await apiClient.patch<ApiEnvelope<Call>>(`/calling/calls/${callId}/outcome`, payload);
    return res.data.data;
  },
};
