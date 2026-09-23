import type { SourceType } from "../../../../generated/prisma/enums.js";

export interface MappedLeadData {
  firstName: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  requirement?: string;
  location?: string;
}

export interface DecryptedCredentials {
  [key: string]: string | undefined;
}

export interface SourceConfig {
  [key: string]: unknown;
}

export interface WebhookHeaders {
  [key: string]: string | string[] | undefined;
}

export interface IntegrationAdapter {
  provider: SourceType;

  /** Resolves the Source's externalAccountId (Page ID / shop domain) from the inbound payload/headers. */
  resolveExternalAccountId(body: unknown, headers: WebhookHeaders): string | null;

  /** Provider's own event/topic name (e.g. Shopify "customers/create"), recorded on WebhookEvent. */
  resolveEventType(body: unknown, headers: WebhookHeaders): string;

  /** Verifies the inbound webhook's signature using the Source's stored credentials. */
  verifySignature(rawBody: string, headers: WebhookHeaders, credentials: DecryptedCredentials): boolean;

  /** Splits a provider payload into individual entries to process. */
  parseWebhookPayload(body: unknown): unknown[];

  /** Optional async enrichment step (e.g. Meta's Graph API follow-up call for lead field data). */
  fetchAdditionalData?(entry: unknown, credentials: DecryptedCredentials): Promise<unknown>;

  /** Maps a (possibly enriched) provider entry to normalized lead fields. */
  mapToLeadData(entry: unknown, config: SourceConfig | null): MappedLeadData | null;
}
