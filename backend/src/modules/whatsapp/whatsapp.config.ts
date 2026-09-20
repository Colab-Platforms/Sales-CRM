// WhatsApp provider configuration, read from the backend environment only - mirrors
// shopify.config.ts. WHATSAPP_PROVIDER selects which BSP is active; leaving it unset disables the
// whole integration safely (see resolveWhatsAppConfig below), the same way a missing
// SHOPIFY_WEBHOOK_SECRET disables the Shopify webhook endpoint rather than accepting unverified data.
//
// Unlike loadShopifyConfig (which throws on a bad config), this module never throws: every call
// site here is something that must keep the rest of the CRM working even when WhatsApp is missing
// or misconfigured (a status endpoint, a webhook receiver, a "send" action a user might click).
// Problems are reported by variable NAME only, exactly like Shopify's config - a bad value is
// never echoed back.

type Env = Record<string, string | undefined>;

export interface AiSensyConfig {
  readonly kind: "AISENSY";
  /** Campaign API key from the AiSensy dashboard. Non-enumerable, like Shopify's access token. */
  readonly apiKey: string;
  /** WhatsApp Business number messages are sent from (informational only). */
  readonly sourceNumber: string;
  /** Shared secret configured in the AiSensy dashboard; verifies X-AiSensy-Signature. */
  readonly webhookSecret: string;
}

/** Gupshup's separate Partner API credentials (E7.2), needed only for template sync - not for sending. */
export interface GupshupTemplateSyncConfig {
  readonly appId: string;
  readonly partnerEmail: string;
  readonly partnerPassword: string;
}

export interface GupshupConfig {
  readonly kind: "GUPSHUP";
  readonly apiKey: string;
  readonly appName: string;
  readonly sourceNumber: string;
  /** The Authorization token Gupshup is configured to send with every webhook callback. */
  readonly webhookToken: string;
  /** null when template-sync-specific env vars are not set - sending still works without these. */
  readonly templateSync: GupshupTemplateSyncConfig | null;
}

export type WhatsAppConfig = AiSensyConfig | GupshupConfig;

export type WhatsAppConfigResult =
  | { ok: true; config: WhatsAppConfig }
  /** provider is null when WHATSAPP_PROVIDER itself is unset - the ordinary "not configured" case. */
  | { ok: false; provider: string | null; problems: string[] };

function nonEnumerable<T extends object>(obj: T, key: keyof T, value: unknown): T {
  Object.defineProperty(obj, key, { value, enumerable: false });
  return obj;
}

function required(env: Env, name: string, problems: string[]): string {
  const value = (env[name] ?? "").trim();
  if (!value) problems.push(`${name} is not set`);
  return value;
}

function resolveAiSensy(env: Env): WhatsAppConfigResult {
  const problems: string[] = [];
  const apiKey = required(env, "AISENSY_API_KEY", problems);
  const sourceNumber = required(env, "AISENSY_SOURCE_NUMBER", problems);
  const webhookSecret = required(env, "AISENSY_WEBHOOK_SECRET", problems);
  if (problems.length > 0) return { ok: false, provider: "AISENSY", problems };

  const config = { kind: "AISENSY", sourceNumber } as AiSensyConfig;
  nonEnumerable(config, "apiKey", apiKey);
  nonEnumerable(config, "webhookSecret", webhookSecret);
  return { ok: true, config };
}

/** Optional: present only if ALL three template-sync variables are set - a partial set is treated as "not set" (never a half-working credential). */
function resolveGupshupTemplateSync(env: Env): GupshupTemplateSyncConfig | null {
  const appId = (env.GUPSHUP_APP_ID ?? "").trim();
  const partnerEmail = (env.GUPSHUP_PARTNER_EMAIL ?? "").trim();
  const partnerPassword = (env.GUPSHUP_PARTNER_PASSWORD ?? "").trim();
  if (!appId || !partnerEmail || !partnerPassword) return null;

  const config = { appId } as GupshupTemplateSyncConfig;
  nonEnumerable(config, "partnerEmail", partnerEmail);
  nonEnumerable(config, "partnerPassword", partnerPassword);
  return config;
}

function resolveGupshup(env: Env): WhatsAppConfigResult {
  const problems: string[] = [];
  const apiKey = required(env, "GUPSHUP_API_KEY", problems);
  const appName = required(env, "GUPSHUP_APP_NAME", problems);
  const sourceNumber = required(env, "GUPSHUP_SOURCE_NUMBER", problems);
  const webhookToken = required(env, "GUPSHUP_WEBHOOK_TOKEN", problems);
  if (problems.length > 0) return { ok: false, provider: "GUPSHUP", problems };

  const config = { kind: "GUPSHUP", appName, sourceNumber, templateSync: resolveGupshupTemplateSync(env) } as GupshupConfig;
  nonEnumerable(config, "apiKey", apiKey);
  nonEnumerable(config, "webhookToken", webhookToken);
  return { ok: true, config };
}

/** The full picture: configured, or not, and why. Used by the status endpoint. */
export function resolveWhatsAppConfig(env: Env = process.env): WhatsAppConfigResult {
  const provider = (env.WHATSAPP_PROVIDER ?? "").trim().toUpperCase();
  if (!provider) return { ok: false, provider: null, problems: ["WHATSAPP_PROVIDER is not set"] };
  if (provider === "AISENSY") return resolveAiSensy(env);
  if (provider === "GUPSHUP") return resolveGupshup(env);
  return { ok: false, provider, problems: [`WHATSAPP_PROVIDER must be "AISENSY" or "GUPSHUP" (got "${provider}")`] };
}

/**
 * The common case: config, or null when WhatsApp is not usable right now for any reason. Callers
 * that just want to send/verify and treat "not configured" and "misconfigured" the same way
 * (both mean: do nothing, report unavailable) should use this instead of resolveWhatsAppConfig.
 */
export function loadWhatsAppConfig(env: Env = process.env): WhatsAppConfig | null {
  const result = resolveWhatsAppConfig(env);
  return result.ok ? result.config : null;
}
