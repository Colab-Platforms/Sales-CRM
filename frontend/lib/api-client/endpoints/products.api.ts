import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CatalogImportStatus, ListProductsParams, ProductListResult } from "../types/products.types";

export const productsApi = {
  /** Records the real unit weight (kg) of a product or one variant, or clears it with null. ADMIN / MANAGER only. */
  async setWeight(target: { kind: "product" | "variant"; id: string }, weightKg: number | null): Promise<{ weightKg: string | null }> {
    const path = target.kind === "variant" ? `/products/variants/${target.id}/weight` : `/products/${target.id}/weight`;
    const res = await apiClient.put<ApiEnvelope<{ weightKg: string | null }>>(path, { weightKg });
    return res.data.data;
  },

  /** Uploads a Shiprocket catalog CSV. Returns at once with a job id; poll catalogImportStatus for progress. ADMIN / MANAGER only. */
  async startCatalogImport(file: File): Promise<{ jobId: string }> {
    const form = new FormData();
    form.append("file", file);
    const res = await apiClient.post<ApiEnvelope<{ jobId: string }>>("/products/catalog-import", form, { timeout: 10 * 60 * 1000, headers: { "Content-Type": "multipart/form-data" } });
    return res.data.data;
  },

  async catalogImportStatus(jobId: string): Promise<CatalogImportStatus> {
    const res = await apiClient.get<ApiEnvelope<CatalogImportStatus>>(`/products/catalog-import/${encodeURIComponent(jobId)}`);
    return res.data.data;
  },

  /** The failed rows as a CSV (Blob), for the person to fix and re-upload. */
  async catalogImportFailedRows(jobId: string): Promise<Blob> {
    const res = await apiClient.get(`/products/catalog-import/${encodeURIComponent(jobId)}/failed-rows`, { responseType: "blob" });
    return res.data as Blob;
  },

  async list(params: ListProductsParams): Promise<ProductListResult> {
    const res = await apiClient.get<ApiEnvelope<ProductListResult>>("/products", { params });
    return res.data.data;
  },
};
