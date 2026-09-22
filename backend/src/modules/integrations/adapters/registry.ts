import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { SourceType } from "../../../../generated/prisma/enums.js";
import type { IntegrationAdapter } from "./adapter.types.js";
import { metaAdapter } from "./meta.adapter.js";
import { shopifyAdapter } from "./shopify.adapter.js";

const adapters: Partial<Record<SourceType, IntegrationAdapter>> = {
  [SourceType.META]: metaAdapter,
  [SourceType.SHOPIFY]: shopifyAdapter,
};

export function getAdapter(provider: string): IntegrationAdapter {
  const type = provider.toUpperCase() as SourceType;
  const adapter = adapters[type];
  if (!adapter) throw new ApiError(`Unsupported integration provider: ${provider}`, STATUS_CODES.BAD_REQUEST);
  return adapter;
}
