import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { refundsApi } from "../endpoints/refunds.api";
import type { RefundQueueParams } from "../types/refunds.types";

export const refundsKeys = {
  all: ["refunds"] as const,
  queue: (params: RefundQueueParams) => [...refundsKeys.all, "queue", params] as const,
  pendingCount: () => [...refundsKeys.all, "pending-count"] as const,
};

export const refundQueueQueryOptions = (params: RefundQueueParams) =>
  queryOptions({ queryKey: refundsKeys.queue(params), queryFn: () => refundsApi.queue(params), staleTime: 10_000, placeholderData: keepPreviousData });

/** The sidebar badge: how many pending requests this approver could act on. Polled, since there is no push notification system. */
export const pendingRefundCountQueryOptions = () =>
  queryOptions({ queryKey: refundsKeys.pendingCount(), queryFn: () => refundsApi.pendingCount(), staleTime: 30_000, refetchInterval: 60_000, retry: false });
