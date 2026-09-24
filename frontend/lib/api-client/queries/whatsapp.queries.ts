import axios from "axios";
import { queryOptions } from "@tanstack/react-query";
import { whatsappApi } from "../endpoints/whatsapp.api";

export const whatsappKeys = {
  all: ["whatsapp"] as const,
  status: () => [...whatsappKeys.all, "status"] as const,
};

const STALE_TIME_MS = 30 * 1000;
const MAX_RETRIES = 2;

function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export function whatsappStatusQueryOptions() {
  return queryOptions({
    queryKey: whatsappKeys.status(),
    queryFn: () => whatsappApi.status(),
    staleTime: STALE_TIME_MS,
    retry: retryUnlessClientError,
  });
}
