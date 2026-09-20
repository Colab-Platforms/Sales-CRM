"use client";

import { useQuery } from "@tanstack/react-query";
import { whatsappTemplateListQueryOptions } from "@/lib/api-client/queries/whatsapp-templates.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { ListTemplatesParams } from "@/lib/api-client/types/whatsapp-templates.types";

export function useWhatsAppTemplates(params: ListTemplatesParams) {
  const token = useAuthStore((s) => s.token);

  const query = useQuery({
    ...whatsappTemplateListQueryOptions(params),
    enabled: Boolean(token),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isFetching: query.isFetching,
    error: query.error ? getErrorMessage(query.error, "Failed to load templates.") : null,
    refetch: query.refetch,
  };
}
