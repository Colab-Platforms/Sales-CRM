import axios from "axios";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { whatsappTemplatesApi } from "../endpoints/whatsapp-templates.api";
import type { ListTemplatesParams } from "../types/whatsapp-templates.types";

export const whatsappTemplateKeys = {
  all: ["whatsapp-templates"] as const,
  list: (params: ListTemplatesParams) => [...whatsappTemplateKeys.all, "list", params] as const,
  detail: (id: string) => [...whatsappTemplateKeys.all, "detail", id] as const,
};

const STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) return false;
  return failureCount < MAX_RETRIES;
}

export function whatsappTemplateListQueryOptions(params: ListTemplatesParams) {
  return queryOptions({
    queryKey: whatsappTemplateKeys.list(params),
    queryFn: () => whatsappTemplatesApi.list(params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function whatsappTemplateDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: whatsappTemplateKeys.detail(id),
    queryFn: () => whatsappTemplatesApi.get(id),
    staleTime: STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}
