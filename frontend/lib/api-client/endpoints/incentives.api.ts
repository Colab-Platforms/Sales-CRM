import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { AdminIncentiveQuery, IncentiveAuditEntry, IncentiveMonth, IncentiveOverview, IncentivePolicy, IncentivePolicyRules } from "../types/incentives.types";

const data = <T,>(p: Promise<{ data: ApiEnvelope<T> }>) => p.then((r) => r.data.data);

export const incentivesApi = {
  // Salesperson: always their own month (the server takes the id from the login).
  mine: (month: string) => data(apiClient.get<ApiEnvelope<IncentiveMonth>>("/incentives/me", { params: { month } })),
  raiseQuery: (month: string, message: string) => data(apiClient.post<ApiEnvelope<IncentiveMonth>>("/incentives/me/queries", { month, message })),

  // Admin.
  overview: (month: string) => data(apiClient.get<ApiEnvelope<IncentiveOverview>>("/incentives/overview", { params: { month } })),
  salespersonMonth: (userId: string, month: string) => data(apiClient.get<ApiEnvelope<IncentiveMonth>>(`/incentives/salespeople/${userId}/${month}`)),
  approve: (userId: string, month: string, note?: string) => data(apiClient.post<ApiEnvelope<IncentiveMonth>>(`/incentives/salespeople/${userId}/${month}/approve`, { note })),
  recordPayment: (userId: string, month: string, body: { paymentRef?: string; note?: string; paidOn?: string }) =>
    data(apiClient.post<ApiEnvelope<IncentiveMonth>>(`/incentives/salespeople/${userId}/${month}/payment`, body)),
  policy: () => data(apiClient.get<ApiEnvelope<IncentivePolicy>>("/incentives/policy")),
  setPolicy: (rules: IncentivePolicyRules) => data(apiClient.put<ApiEnvelope<IncentivePolicy>>("/incentives/policy", rules)),
  queries: (status?: "OPEN" | "RESOLVED") => data(apiClient.get<ApiEnvelope<AdminIncentiveQuery[]>>("/incentives/queries", { params: status ? { status } : {} })),
  resolveQuery: (id: string, response: string) => data(apiClient.post<ApiEnvelope<{ ok: true }>>(`/incentives/queries/${id}/resolve`, { response })),
  audit: (f: { userId?: string; month?: string } = {}) => data(apiClient.get<ApiEnvelope<IncentiveAuditEntry[]>>("/incentives/audit", { params: f })),
};
