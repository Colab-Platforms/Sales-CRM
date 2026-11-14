// Config for the Fastrr (Shiprocket Checkout) REPORTING API - the endpoint the Fastrr dashboard's "Abandoned Carts" page reads. Separate from fastrr.config.ts (promotion API) and from
// shiprocket.config.ts (shipping API): this product has its own host and its own two credential headers. Credentials come ONLY from the environment, never from a request, and are
// stored non-enumerable so they cannot be serialised into a log line or an API response by accident.

type Env = Record<string, string | undefined>;

export const DEFAULT_REPORTING_BASE_URL = "https://reporting.pickrr.com";
export const ABANDONED_CARTS_PATH = "/api/ve1/dashboard-service/report/abandon-carts";
export const FASTRR_SOURCE = "fastrr";

export class FastrrRecoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastrrRecoveryConfigError";
  }
}

export interface FastrrRecoveryConfig {
  /** https, no trailing slash, host must be on pickrr.com (credentials are never sent anywhere else). */
  readonly baseUrl: string;
  /** Sent as the `x-auth` header. Non-enumerable. */
  readonly authToken: string;
  /** Sent as the `authentication-info` header. Non-enumerable. */
  readonly authInfo: string;
}

// printable ASCII, no control characters / line breaks (header injection)
const HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;

/** Required: FASTRR_REPORTING_AUTH_TOKEN and FASTRR_REPORTING_AUTH_INFO. Optional: FASTRR_REPORTING_BASE_URL (default https://reporting.pickrr.com). */
export function loadFastrrRecoveryConfig(env: Env = process.env): FastrrRecoveryConfig {
  const baseUrl = (env.FASTRR_REPORTING_BASE_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_REPORTING_BASE_URL;
  const authToken = (env.FASTRR_REPORTING_AUTH_TOKEN ?? "").trim();
  const authInfo = (env.FASTRR_REPORTING_AUTH_INFO ?? "").trim();
  const problems: string[] = [];
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") problems.push("FASTRR_REPORTING_BASE_URL must be an https URL");
    else if (host !== "pickrr.com" && !host.endsWith(".pickrr.com")) problems.push("FASTRR_REPORTING_BASE_URL must be on pickrr.com");
  } catch {
    problems.push("FASTRR_REPORTING_BASE_URL is not a valid URL");
  }
  if (!authToken) problems.push("FASTRR_REPORTING_AUTH_TOKEN is not set");
  else if (!HEADER_VALUE.test(authToken)) problems.push("FASTRR_REPORTING_AUTH_TOKEN has invalid characters");
  if (!authInfo) problems.push("FASTRR_REPORTING_AUTH_INFO is not set");
  else if (!HEADER_VALUE.test(authInfo)) problems.push("FASTRR_REPORTING_AUTH_INFO has invalid characters");
  // Variable names and rules only - a rejected value is never echoed.
  if (problems.length > 0) throw new FastrrRecoveryConfigError(`Fastrr recovery is not configured: ${problems.join("; ")}`);
  const config = { baseUrl } as { baseUrl: string; authToken: string; authInfo: string };
  Object.defineProperty(config, "authToken", { value: authToken, enumerable: false, writable: false });
  Object.defineProperty(config, "authInfo", { value: authInfo, enumerable: false, writable: false });
  return config as FastrrRecoveryConfig;
}

export function isFastrrRecoveryConfigured(env: Env = process.env): boolean {
  try {
    loadFastrrRecoveryConfig(env);
    return true;
  } catch {
    return false;
  }
}
