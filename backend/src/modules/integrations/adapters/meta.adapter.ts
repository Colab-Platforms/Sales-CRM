import { createHmac, timingSafeEqual } from "node:crypto";
import { SourceType } from "../../../../generated/prisma/enums.js";
import type { IntegrationAdapter, DecryptedCredentials, MappedLeadData, WebhookHeaders } from "./adapter.types.js";

interface MetaChange {
  field: string;
  value: {
    leadgen_id: string;
    page_id: string;
    form_id: string;
    created_time?: number;
  };
}

interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

interface MetaWebhookBody {
  object: string;
  entry: MetaEntry[];
}

interface MetaFieldDatum {
  name: string;
  values: string[];
}

interface MetaLeadDetails {
  leadgen_id?: string;
  field_data?: MetaFieldDatum[];
}

const FIELD_ALIASES: Record<string, keyof MappedLeadData> = {
  first_name: "firstName",
  last_name: "lastName",
  full_name: "firstName",
  phone_number: "mobile",
  email: "email",
  city: "location",
};

export const metaAdapter: IntegrationAdapter = {
  provider: SourceType.META,

  resolveExternalAccountId(body: unknown): string | null {
    const payload = body as MetaWebhookBody;
    return payload?.entry?.[0]?.id ?? null;
  },

  resolveEventType(body: unknown): string {
    const payload = body as MetaWebhookBody;
    return payload?.entry?.[0]?.changes?.[0]?.field ?? "unknown";
  },

  verifySignature(rawBody: string, headers: WebhookHeaders, credentials: DecryptedCredentials): boolean {
    const appSecret = credentials.appSecret;
    if (!appSecret) return false;

    const signatureHeader = headers["x-hub-signature-256"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!signature?.startsWith("sha256=")) return false;

    const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
    const provided = signature.slice("sha256=".length);

    const expectedBuf = Buffer.from(expected, "hex");
    const providedBuf = Buffer.from(provided, "hex");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  },

  parseWebhookPayload(body: unknown): unknown[] {
    const payload = body as MetaWebhookBody;
    const entries: MetaChange["value"][] = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === "leadgen") entries.push(change.value);
      }
    }
    return entries;
  },

  async fetchAdditionalData(entry: unknown, credentials: DecryptedCredentials): Promise<unknown> {
    const value = entry as MetaChange["value"];
    const accessToken = credentials.pageAccessToken;
    if (!accessToken || !value?.leadgen_id) return entry;

    const url = `https://graph.facebook.com/v19.0/${value.leadgen_id}?fields=field_data&access_token=${encodeURIComponent(accessToken)}`;
    const response = await fetch(url);
    if (!response.ok) return entry;

    const details = (await response.json()) as MetaLeadDetails;
    return { ...value, field_data: details.field_data ?? [] };
  },

  mapToLeadData(entry: unknown): MappedLeadData | null {
    const value = entry as MetaChange["value"] & { field_data?: MetaFieldDatum[] };
    const fields: Partial<Record<keyof MappedLeadData, string>> = {};

    for (const datum of value.field_data ?? []) {
      const key = FIELD_ALIASES[datum.name];
      if (key && datum.values?.[0]) fields[key] = datum.values[0];
    }

    if (!fields.firstName) return null;

    return {
      firstName: fields.firstName,
      lastName: fields.lastName,
      mobile: fields.mobile,
      email: fields.email,
      location: fields.location,
    };
  },
};
