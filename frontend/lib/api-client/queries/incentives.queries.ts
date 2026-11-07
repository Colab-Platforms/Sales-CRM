import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { incentivesApi } from "../endpoints/incentives.api";

export const incentiveKeys = {
  all: ["incentives"] as const,
  mine: (month: string) => [...incentiveKeys.all, "mine", month] as const,
  overview: (month: string, range?: { from: string; to: string }) => [...incentiveKeys.all, "overview", month, range?.from ?? "", range?.to ?? ""] as const,
  month: (userId: string, month: string) => [...incentiveKeys.all, "month", userId, month] as const,
  policy: () => [...incentiveKeys.all, "policy"] as const,
  queries: (status?: string) => [...incentiveKeys.all, "queries", status ?? "all"] as const,
  audit: () => [...incentiveKeys.all, "audit"] as const,
};

/** Re-read every 5 minutes, so new calls, orders and status changes show up without a reload. */
export const myIncentiveQueryOptions = (month: string) =>
  queryOptions({ queryKey: incentiveKeys.mine(month), queryFn: () => incentivesApi.mine(month), placeholderData: keepPreviousData, refetchInterval: 5 * 60_000 });

export const incentiveOverviewQueryOptions = (month: string, range?: { from: string; to: string }) =>
  queryOptions({ queryKey: incentiveKeys.overview(month, range), queryFn: ({ signal }) => incentivesApi.overview(month, range, signal), placeholderData: keepPreviousData, retry: 1 });

export const incentiveMonthQueryOptions = (userId: string, month: string) =>
  queryOptions({ queryKey: incentiveKeys.month(userId, month), queryFn: () => incentivesApi.salespersonMonth(userId, month) });

export const incentivePolicyQueryOptions = () => queryOptions({ queryKey: incentiveKeys.policy(), queryFn: () => incentivesApi.policy() });

export const incentiveQueriesQueryOptions = (status?: "OPEN" | "RESOLVED") => queryOptions({ queryKey: incentiveKeys.queries(status), queryFn: () => incentivesApi.queries(status) });

export const incentiveAuditQueryOptions = () => queryOptions({ queryKey: incentiveKeys.audit(), queryFn: () => incentivesApi.audit() });
