// Shopify connection settings, read from the backend environment only.
// Nothing here is ever sent to the frontend.

import { DEFAULT_START_DATE, isRealDay } from "./shopify.window.js";

export interface ShopifyConfig {
  /** e.g. "your-store.myshopify.com" */
  readonly storeDomain: string;
  /** e.g. "2026-07" */
  readonly apiVersion: string;
  /** Gates the future database sync. The read-only dry run does not need it. */
  readonly syncEnabled: boolean;
  /** First day (store time, YYYY-MM-DD) of the orders the CRM keeps. Older orders are not imported unless --since asks. */
  readonly syncStartDate: string;
  /** Admin API access token. Non-enumerable so it never appears in JSON.stringify, console.log or util.inspect. */
  readonly accessToken: string;
}

/** What the webhook endpoint needs to authenticate a delivery. Deliberately separate from the API token. */
export interface ShopifyWebhookConfig {
  readonly syncEnabled: boolean;
  /** Same start date as the CLI: a webhook for an order created before it is ignored. */
  readonly syncStartDate: string;
  /** The app's client secret, used to verify X-Shopify-Hmac-SHA256. Non-enumerable, like the access token. */
  readonly secret: string;
}

export class ShopifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyConfigError";
  }
}

type Env = Record<string, string | undefined>;

export const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION_PATTERN = /^\d{4}-(01|04|07|10)$/;

function readStartDate(env: Env, problems: string[]): string {
  const value = (env.SHOPIFY_SYNC_START_DATE ?? "").trim();
  if (!value) return DEFAULT_START_DATE;
  if (!isRealDay(value)) problems.push("SHOPIFY_SYNC_START_DATE must be a calendar date such as 2026-01-01");
  return value;
}

// Problems are reported by variable NAME and rule only. A rejected value is never echoed,
// so a mistyped secret can't end up in a terminal or log.
export function loadShopifyConfig(env: Env = process.env): ShopifyConfig {
  const problems: string[] = [];

  const storeDomain = (env.SHOPIFY_STORE_DOMAIN ?? "").trim().toLowerCase();
  if (!storeDomain) {
    problems.push("SHOPIFY_STORE_DOMAIN is not set");
  } else if (!DOMAIN_PATTERN.test(storeDomain)) {
    problems.push("SHOPIFY_STORE_DOMAIN must look like your-store.myshopify.com (no https://, no path)");
  }

  const accessToken = (env.SHOPIFY_ACCESS_TOKEN ?? "").trim();
  if (!accessToken) {
    problems.push("SHOPIFY_ACCESS_TOKEN is not set");
  } else if (/\s/.test(accessToken)) {
    problems.push("SHOPIFY_ACCESS_TOKEN must not contain whitespace");
  }

  const apiVersion = (env.SHOPIFY_API_VERSION ?? "").trim();
  if (!apiVersion) {
    problems.push("SHOPIFY_API_VERSION is not set");
  } else if (!API_VERSION_PATTERN.test(apiVersion)) {
    problems.push("SHOPIFY_API_VERSION must be a quarterly version such as 2026-07");
  }

  const syncFlag = (env.SHOPIFY_SYNC_ENABLED ?? "false").trim().toLowerCase();
  if (!["true", "false", ""].includes(syncFlag)) {
    problems.push("SHOPIFY_SYNC_ENABLED must be true or false");
  }

  const syncStartDate = readStartDate(env, problems);

  if (problems.length > 0) {
    throw new ShopifyConfigError(`Shopify configuration is incomplete:\n  - ${problems.join("\n  - ")}`);
  }

  const config = { storeDomain, apiVersion, syncEnabled: syncFlag === "true", syncStartDate } as ShopifyConfig;
  Object.defineProperty(config, "accessToken", { value: accessToken, enumerable: false });
  return config;
}

/**
 * Webhook settings, or null when webhooks are not configured (no SHOPIFY_WEBHOOK_SECRET).
 * When it is null the endpoint refuses every delivery rather than accepting unverified ones.
 */
export function loadWebhookConfig(env: Env = process.env): ShopifyWebhookConfig | null {
  const secret = (env.SHOPIFY_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return null;

  const problems: string[] = [];
  const syncStartDate = readStartDate(env, problems);
  // A bad start date must not silently widen what webhooks import, so it disables the endpoint like a missing secret.
  if (problems.length > 0) return null;

  const config = {
    syncEnabled: (env.SHOPIFY_SYNC_ENABLED ?? "false").trim().toLowerCase() === "true",
    syncStartDate,
  } as ShopifyWebhookConfig;
  Object.defineProperty(config, "secret", { value: secret, enumerable: false });
  return config;
}
