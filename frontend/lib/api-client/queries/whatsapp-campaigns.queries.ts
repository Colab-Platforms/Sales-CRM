import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { whatsappCampaignsApi } from "../endpoints/whatsapp-campaigns.api";
import type { ListCampaignRecipientsParams, ListCampaignsParams } from "../types/whatsapp-campaigns.types";

export const whatsappCampaignKeys = {
  all: ["whatsapp-campaigns"] as const,
  list: (params: ListCampaignsParams) => [...whatsappCampaignKeys.all, "list", params] as const,
  detail: (id: string) => [...whatsappCampaignKeys.all, "detail", id] as const,
  recipients: (id: string, params: ListCampaignRecipientsParams) => [...whatsappCampaignKeys.all, "recipients", id, params] as const,
};

const STALE_TIME_MS = 15 * 1000;

export function whatsappCampaignListQueryOptions(params: ListCampaignsParams) {
  return queryOptions({
    queryKey: whatsappCampaignKeys.list(params),
    queryFn: () => whatsappCampaignsApi.list(params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });
}

export function whatsappCampaignDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: whatsappCampaignKeys.detail(id),
    queryFn: () => whatsappCampaignsApi.get(id),
    staleTime: STALE_TIME_MS,
  });
}

export function whatsappCampaignRecipientsQueryOptions(id: string, params: ListCampaignRecipientsParams) {
  return queryOptions({
    queryKey: whatsappCampaignKeys.recipients(id, params),
    queryFn: () => whatsappCampaignsApi.listRecipients(id, params),
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });
}
