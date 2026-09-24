import { queryOptions } from "@tanstack/react-query";
import { whatsappAutomationsApi } from "../endpoints/whatsapp-automations.api";

export const whatsappAutomationKeys = {
  all: ["whatsapp-automations"] as const,
  list: () => [...whatsappAutomationKeys.all, "list"] as const,
};

const STALE_TIME_MS = 30 * 1000;

export function whatsappAutomationListQueryOptions() {
  return queryOptions({
    queryKey: whatsappAutomationKeys.list(),
    queryFn: () => whatsappAutomationsApi.list(),
    staleTime: STALE_TIME_MS,
  });
}
