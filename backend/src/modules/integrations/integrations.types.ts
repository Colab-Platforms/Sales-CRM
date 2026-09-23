export type SourceTypeValue = "MANUAL" | "CSV" | "META" | "SHOPIFY" | "API";
export type SourceStatusValue = "ACTIVE" | "INACTIVE";

export interface CreateSourceBody {
  name: string;
  type: SourceTypeValue;
  description?: string;
  externalAccountId?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
}

export interface UpdateSourceBody {
  name?: string;
  description?: string;
  externalAccountId?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
}

export interface ListSourcesQuery {
  type?: SourceTypeValue;
  status?: SourceStatusValue;
}

export interface ToggleSourceStatusBody {
  status: SourceStatusValue;
}

export interface ListSourceEventsQuery {
  limit: number;
}
