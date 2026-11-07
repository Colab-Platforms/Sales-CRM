import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { incentivesApi } from "../endpoints/incentives.api";

export const incentiveKeys = {
  all: ["incentives"] as const,
  mine: (month: string) => [...incentiveKeys.all, "mine", month] as const,
  overview: (month: string) => [...incentiveKeys.all, "overview", month] as const,
  month: (userId: string, month: string) => [...incentiveKeys.all, "month", userId, month] as const,
  policy: () => [...incentiveKeys.all, "policy"] as const,
  queries: (status?: string) => [...incentiveKeys.all, "queries", status ?? "all"] as const,
  audit: () => [...incentiveKeys.all, "audit"] as const,
};

/** Re-read every 5 minutes, so new calls, orders and status changes show up without a reload. */
export const myIncentiveQueryOptions = (month: string) =>
  queryOptions({ queryKey: incentiveKeys.mine(month), queryFn: () => incentivesApi.mine(month), placeholderData: keepPreviousData, refetchInterval: 5 * 60_000 });

export const incentiveOverviewQueryOptions = (month: string) =>
  queryOptions({ queryKey: incentiveKeys.overview(month), queryFn: () => incentivesApi.overview(month), placeholderData: keepPreviousData });

export const incentiveMonthQueryOptions = (userId: string, month: string) =>
  queryOptions({ queryKey: incentiveKeys.month(userId, month), queryFn: () => incentivesApi.salespersonMonth(userId, month) });

export const incentivePolicyQueryOptions = () => queryOptions({ queryKey: incentiveKeys.policy(), queryFn: () => incentivesApi.policy() });

export const incentiveQueriesQueryOptions = (status?: "OPEN" | "RESOLVED") => queryOptions({ queryKey: incentiveKeys.queries(status), queryFn: () => incentivesApi.queries(status) });

export const incentiveAuditQueryOptions = () => queryOptions({ queryKey: incentiveKeys.audit(), queryFn: () => incentivesApi.audit() });
