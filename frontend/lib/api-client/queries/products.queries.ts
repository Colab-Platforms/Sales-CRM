import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { productsApi } from "../endpoints/products.api";
import type { ListProductsParams } from "../types/products.types";

export const productsKeys = {
  all: ["products"] as const,
  list: (params: ListProductsParams) => [...productsKeys.all, "list", params] as const,
};

export function productListQueryOptions(params: ListProductsParams) {
  return queryOptions({
    queryKey: productsKeys.list(params),
    queryFn: () => productsApi.list(params),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
