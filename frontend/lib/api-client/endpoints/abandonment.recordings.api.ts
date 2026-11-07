import axios from "axios";
import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";

// Call recordings of abandoned leads. ADMIN / MANAGER only - the server enforces it (403 for anyone else); the UI merely does not offer the controls.

export interface RecordingSummary {
  from: string;
  to: string;
  total: number;
  available: number;
  unavailable: number;
  duplicates: number;
}

export type RecordingExportStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export type RecordingExportKind = "ZIP" | "EXCEL";

export interface RecordingExport {
  id: string;
  kind: RecordingExportKind;
  status: RecordingExportStatus;
  from: string;
  to: string;
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  percent: number;
  duplicates: number;
  sizeBytes: number;
  fileName: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
  canDownload: boolean;
  /** "IDS": exactly the leads that were ticked; "MATCHING": every lead the list filters matched; null: the date range. */
  selection: "IDS" | "MATCHING" | null;
  selectedCount: number | null;
  /** Salesperson / lead status / search filters were applied on top of the date range. */
  filtered: boolean;
  /** Running with no sign of life (the worker restarted): the server picks it up again by itself. */
  stalled: boolean;
  /** Times a server-side problem interrupted it (it resumes each time). */
  attempts: number;
  canRetry: boolean;
  reused?: boolean;
}

export interface RecordingFile {
  blob: Blob;
  fileName: string;
}

/**
 * What to tell the user about a failed request, without hiding the cause: the server's own message when it sent one, otherwise whether the server could not be reached at all
 * or answered with an error status (a proxy / gateway page has no message, which is why a bare fallback text used to be all anyone saw).
 */
export function describeRequestError(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: string } | undefined)?.message;
    if (message) return message;
    if (!error.response) return `${fallback} The server could not be reached - check your connection and try again.`;
    return `${fallback} (server error ${error.response.status}).`;
  }
  return error instanceof Error ? error.message : fallback;
}

/** Error text from a failed blob download (the server's JSON error arrives as a Blob). */
async function blobError(error: unknown, fallback: string): Promise<Error> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const parsed = JSON.parse(await error.response.data.text()) as { message?: string };
      if (parsed.message) return new Error(parsed.message);
    } catch {
      // not JSON: use the fallback
    }
  }
  if (axios.isAxiosError(error)) return new Error((error.response?.data as { message?: string } | undefined)?.message ?? fallback);
  return new Error(fallback);
}

function fileNameOf(disposition: unknown, fallback: string): string {
  const match = typeof disposition === "string" ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

export const abandonmentRecordingsApi = {
  async summary(range: { from: string; to: string }): Promise<RecordingSummary> {
    const res = await apiClient.get<ApiEnvelope<RecordingSummary>>("/abandonments/recordings/summary", { params: range });
    return res.data.data;
  },

  async downloadOne(callId: string): Promise<RecordingFile> {
    try {
      const res = await apiClient.get<Blob>(`/abandonments/recordings/${callId}/download`, { responseType: "blob" });
      return { blob: res.data, fileName: fileNameOf(res.headers["content-disposition"], `recording-${callId}.mp3`) };
    } catch (error) {
      throw await blobError(error, "Could not download this recording.");
    }
  },

  /** Starts a background export (or returns the one already running for the same range). */
  async startExport(input: { kind: RecordingExportKind; from: string; to: string; filters?: Record<string, unknown> }): Promise<RecordingExport> {
    const res = await apiClient.post<ApiEnvelope<RecordingExport>>("/abandonments/recordings/exports", input);
    return res.data.data;
  },

  /** The user's recent, not yet expired exports (newest first) - how the panel finds an export again after a refresh. */
  async listExports(): Promise<RecordingExport[]> {
    const res = await apiClient.get<ApiEnvelope<RecordingExport[]>>("/abandonments/recordings/exports");
    return res.data.data;
  },

  async getExport(id: string): Promise<RecordingExport> {
    const res = await apiClient.get<ApiEnvelope<RecordingExport>>(`/abandonments/recordings/exports/${id}`);
    return res.data.data;
  },

  async retryExport(id: string): Promise<RecordingExport> {
    const res = await apiClient.post<ApiEnvelope<RecordingExport>>(`/abandonments/recordings/exports/${id}/retry`);
    return res.data.data;
  },

  /** A short-lived link the browser follows itself, so a large ZIP streams to disk (never held in page memory). Returns an absolute URL. */
  async exportDownloadUrl(id: string): Promise<string> {
    const res = await apiClient.post<ApiEnvelope<{ url: string }>>(`/abandonments/recordings/exports/${id}/download-link`);
    const base = String(apiClient.defaults.baseURL ?? "").replace(/\/+$/, "");
    return `${base}${res.data.data.url}`;
  },
};

/** Hands a downloaded blob to the browser as a file save. */
export function saveBlob(file: { blob: Blob; fileName: string }): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
