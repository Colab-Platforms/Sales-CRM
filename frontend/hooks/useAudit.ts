"use client";

import { useQuery } from "@tanstack/react-query";
import {
  auditListQueryOptions,
  customerAuditQueryOptions,
  orderAuditQueryOptions,
} from "@/lib/api-client/queries/audit.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { AuditListParams, EntityAuditParams } from "@/lib/api-client/types/audit.types";

export function useAudit(params: AuditListParams, options: { enabled?: boolean } = {}) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...auditListQueryOptions(params),
    enabled: Boolean(token) && (options.enabled ?? true),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load audit trail.") : null,
    refetch: query.refetch,
  };
}

export function useOrderAudit(orderId: string, params: EntityAuditParams) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...orderAuditQueryOptions(orderId, params),
    enabled: Boolean(token),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load audit history.") : null,
  };
}

export function useCustomerAudit(leadId: string, params: EntityAuditParams) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...customerAuditQueryOptions(leadId, params),
    enabled: Boolean(token),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load audit history.") : null,
  };
}
