import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ListProductsParams, ProductListResult } from "../types/products.types";

export const productsApi = {
  async list(params: ListProductsParams): Promise<ProductListResult> {
    const res = await apiClient.get<ApiEnvelope<ProductListResult>>("/products", { params });
    return res.data.data;
  },
};
