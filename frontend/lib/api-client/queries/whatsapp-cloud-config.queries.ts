import { queryOptions } from "@tanstack/react-query";
import { whatsappCloudConfigApi } from "../endpoints/whatsapp-cloud-config.api";

export const whatsappCloudConfigKeys = {
  all: ["whatsapp-cloud-config"] as const,
};

export function whatsappCloudConfigQueryOptions() {
  return queryOptions({
    queryKey: whatsappCloudConfigKeys.all,
    queryFn: whatsappCloudConfigApi.getConfig,
  });
}
