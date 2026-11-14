import axios from "axios";
import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";

// Fastrr abandoned-cart recovery (admin / manager). The Fastrr credentials live on the server only; nothing here ever sees them.

export interface RecoveryCounts {
  fetched: number;
  existing: number;
  missing: number;
  duplicates: number;
  invalid: number;
  converted: number;
}

export interface RecoveryPreview {
  from: string;
  to: string;
  includeConverted: boolean;
  counts: RecoveryCounts;
  pages: number;
  complete: boolean;
  reportedTotal: number | null;
  warnings: string[];
  sampleMissing: { cartId: string | null; customerName: string; phone: string; items: string; cartValue: number | null; abandonedAt: string | null; hasAddress: boolean }[];
  sampleInvalid: { cartId: string | null; reason: string | null }[];
}

export interface RecoveryRun extends RecoveryCounts {
  id: string;
  fromDay: string;
  toDay: string;
  includeConverted: boolean;
  retryOfId: string | null;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  imported: number;
  merged: number;
  skippedExisting: number;
  failed: number;
  errors: { cartId: string; reason: string }[] | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RecoveryRange {
  from: string;
  to: string;
  includeConverted: boolean;
}

export const fastrrRecoveryApi = {
  async status(): Promise<{ configured: boolean }> {
    return (await apiClient.get<ApiEnvelope<{ configured: boolean }>>("/fastrr-recovery/status")).data.data;
  },
  async preview(range: RecoveryRange): Promise<RecoveryPreview> {
    return (await apiClient.post<ApiEnvelope<RecoveryPreview>>("/fastrr-recovery/preview", range, { timeout: 180_000 })).data.data;
  },
  async startImport(range: RecoveryRange & { expectedMissing: number }): Promise<RecoveryRun> {
    return (await apiClient.post<ApiEnvelope<RecoveryRun>>("/fastrr-recovery/import", { ...range, confirm: true }, { timeout: 180_000 })).data.data;
  },
  async retry(id: string): Promise<RecoveryRun> {
    return (await apiClient.post<ApiEnvelope<RecoveryRun>>(`/fastrr-recovery/runs/${id}/retry`, {}, { timeout: 180_000 })).data.data;
  },
  async runs(): Promise<RecoveryRun[]> {
    return (await apiClient.get<ApiEnvelope<{ runs: RecoveryRun[] }>>("/fastrr-recovery/runs")).data.data.runs;
  },
  async exportExcel(range: RecoveryRange): Promise<{ blob: Blob; fileName: string }> {
    try {
      const res = await apiClient.get<Blob>("/fastrr-recovery/export", { params: range, responseType: "blob", timeout: 180_000 });
      const match = /filename="?([^";]+)"?/i.exec(String(res.headers["content-disposition"] ?? ""));
      return { blob: res.data, fileName: match?.[1] ?? `fastrr-abandoned-carts_${range.from}_to_${range.to}.xlsx` };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
        try {
          const parsed = JSON.parse(await error.response.data.text()) as { message?: string };
          if (parsed.message) throw new Error(parsed.message);
        } catch (inner) {
          if (inner instanceof Error && inner.message !== "Unexpected end of JSON input" && !(inner instanceof SyntaxError)) throw inner;
        }
      }
      throw new Error("Could not create the Excel file.");
    }
  },
};
