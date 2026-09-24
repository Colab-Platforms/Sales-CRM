// Cashfree connection settings, read from the backend environment only. Nothing here is ever sent to the frontend.
//
// The API host is chosen from CASHFREE_ENV and never taken from a variable, so credentials can only ever be sent to
// Cashfree's own sandbox or production host. (The older CASHFREE_API_URL / CASHFREE_BASE_URL variables are ignored.)

export type CashfreeEnvironment = "sandbox" | "production";

export const CASHFREE_BASE_URLS: Record<CashfreeEnvironment, string> = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};

/** The Cashfree PG API version this integration was written against (from Cashfree's current API reference). */
export const DEFAULT_API_VERSION = "2026-01-01";

export interface CashfreeConfig {
  readonly environment: CashfreeEnvironment;
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly clientId: string;
  /** Non-enumerable so it never appears in JSON.stringify, console.log or util.inspect. Also the webhook signing secret. */
  readonly clientSecret: string;
  /** Where Cashfree posts payment events. null when PUBLIC_BACKEND_URL is not a public https URL - links still work, but their status only updates through "refresh". */
  readonly notifyUrl: string | null;
  /** Optional page the customer returns to after paying. */
  readonly returnUrl: string | null;
  readonly linkExpiryHours: number;
}

export class CashfreeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashfreeConfigError";
  }
}

type Env = Record<string, string | undefined>;

const flag = (env: Env) => (env.CASHFREE_ENABLED ?? "").trim().toLowerCase() === "true";

/** Cashfree stays fully off unless CASHFREE_ENABLED=true, the same convention as WHATSAPP_PROVIDER / SHOPIFY_SYNC_ENABLED. */
export const isCashfreeEnabled = (env: Env = process.env): boolean => flag(env);

function hide(config: object, key: string, value: string) {
  Object.defineProperty(config, key, { value, enumerable: false, writable: false });
}

// Problems are reported by variable NAME and rule only; a rejected value is never echoed.
export function loadCashfreeConfig(env: Env = process.env): CashfreeConfig {
  if (!flag(env)) throw new CashfreeConfigError("Cashfree is not enabled (CASHFREE_ENABLED is not true)");
  const problems: string[] = [];

  const environment = (env.CASHFREE_ENV ?? "sandbox").trim().toLowerCase();
  if (environment !== "sandbox" && environment !== "production") problems.push("CASHFREE_ENV must be sandbox or production");

  const clientId = (env.CASHFREE_CLIENT_ID ?? "").trim();
  if (!clientId) problems.push("CASHFREE_CLIENT_ID is not set");
  else if (/\s/.test(clientId)) problems.push("CASHFREE_CLIENT_ID must not contain whitespace");

  const clientSecret = (env.CASHFREE_CLIENT_SECRET ?? "").trim();
  if (!clientSecret) problems.push("CASHFREE_CLIENT_SECRET is not set");
  else if (/\s/.test(clientSecret)) problems.push("CASHFREE_CLIENT_SECRET must not contain whitespace");

  const apiVersion = (env.CASHFREE_API_VERSION ?? DEFAULT_API_VERSION).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) problems.push("CASHFREE_API_VERSION must look like 2026-01-01");

  const hoursText = (env.CASHFREE_LINK_EXPIRY_HOURS ?? "72").trim();
  const linkExpiryHours = Number(hoursText);
  if (!Number.isInteger(linkExpiryHours) || linkExpiryHours < 1 || linkExpiryHours > 720) problems.push("CASHFREE_LINK_EXPIRY_HOURS must be a whole number from 1 to 720");

  const publicUrl = (env.PUBLIC_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  const notifyUrl = /^https:\/\/[^\s/]+/i.test(publicUrl) ? `${publicUrl}/api/webhooks/cashfree` : null;

  const returnUrl = (env.CASHFREE_RETURN_URL ?? "").trim() || null;
  if (returnUrl && (!/^https:\/\//i.test(returnUrl) || returnUrl.length > 250)) problems.push("CASHFREE_RETURN_URL must be an https URL of at most 250 characters");

  if (problems.length > 0) throw new CashfreeConfigError(`Cashfree is misconfigured: ${problems.join("; ")}`);

  const config = { environment: environment as CashfreeEnvironment, baseUrl: CASHFREE_BASE_URLS[environment as CashfreeEnvironment], apiVersion, clientId, notifyUrl, returnUrl, linkExpiryHours } as CashfreeConfig;
  hide(config, "clientSecret", clientSecret);
  return config;
}

/** What the webhook endpoint needs to authenticate a delivery. null when Cashfree is off or has no secret, so the endpoint refuses everything. */
export function loadCashfreeWebhookConfig(env: Env = process.env): { readonly secret: string } | null {
  if (!flag(env)) return null;
  const secret = (env.CASHFREE_CLIENT_SECRET ?? "").trim();
  if (!secret) return null;
  const config = {} as { secret: string };
  hide(config, "secret", secret);
  return config;
}
