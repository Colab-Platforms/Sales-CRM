export type SourceType = "MANUAL" | "CSV" | "META" | "SHOPIFY" | "API";
export type SourceStatus = "ACTIVE" | "INACTIVE";

export interface Source {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  type: SourceType;
  status: SourceStatus;
  config: Record<string, unknown> | null;
  hasCredentials: boolean;
  externalAccountId: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEventSummary {
  id: string;
  provider: string;
  eventType: string;
  status: "RECEIVED" | "PROCESSED" | "FAILED" | "IGNORED";
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface CreateSourcePayload {
  name: string;
  type: SourceType;
  description?: string;
  externalAccountId?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
}

export interface UpdateSourcePayload {
  name?: string;
  description?: string;
  externalAccountId?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
}
