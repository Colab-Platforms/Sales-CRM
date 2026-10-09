import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CreateTicketInput, TicketComment, TicketDetail, TicketListParams, TicketListResult, TicketStatus, TicketView } from "../types/tickets.types";

export const ticketsApi = {
  async create(input: CreateTicketInput): Promise<TicketView> {
    const res = await apiClient.post<ApiEnvelope<TicketView>>("/tickets", input);
    return res.data.data;
  },
  async list(params: TicketListParams): Promise<TicketListResult> {
    const res = await apiClient.get<ApiEnvelope<TicketListResult>>("/tickets", { params });
    return res.data.data;
  },
  async openCount(): Promise<{ count: number }> {
    const res = await apiClient.get<ApiEnvelope<{ count: number }>>("/tickets/open-count");
    return res.data.data;
  },
  async get(id: string): Promise<TicketDetail> {
    const res = await apiClient.get<ApiEnvelope<TicketDetail>>(`/tickets/${id}`);
    return res.data.data;
  },
  async addComment(id: string, body: string): Promise<TicketComment> {
    const res = await apiClient.post<ApiEnvelope<TicketComment>>(`/tickets/${id}/comments`, { body });
    return res.data.data;
  },
  async setStatus(id: string, status: TicketStatus): Promise<TicketView> {
    const res = await apiClient.patch<ApiEnvelope<TicketView>>(`/tickets/${id}/status`, { status });
    return res.data.data;
  },
};
