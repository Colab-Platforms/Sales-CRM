// Config for Fastrr (Shiprocket) Checkout's promotion API. Deliberately separate from shiprocket.config.ts: that is the
// shipping API (apiv2.shiprocket.in, email/password login); this is the Checkout product's own API with its own base URL
// and credential. Neither value has a default - the base URL and token come only from the environment, so nothing is guessed
// and credentials can only ever be sent to a host the operator configured.

type Env = Record<string, string | undefined>;

export class FastrrConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastrrConfigError";
  }
}

export interface FastrrConfig {
  /** No trailing slash, https only. */
  readonly baseUrl: string;
  readonly token: string;
}

/** Required: FASTRR_API_BASE_URL (https URL given by Fastrr) and FASTRR_API_TOKEN (the seller's Bearer JWT / API key). */
export function loadFastrrConfig(env: Env = process.env): FastrrConfig {
  const baseUrl = (env.FASTRR_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.FASTRR_API_TOKEN ?? "").trim();
  const problems: string[] = [];
  if (!baseUrl) problems.push("FASTRR_API_BASE_URL is not set");
  else if (!/^https:\/\/[^\s/]+/i.test(baseUrl)) problems.push("FASTRR_API_BASE_URL must be an https URL");
  if (!token) problems.push("FASTRR_API_TOKEN is not set");
  else if (/\s/.test(token)) problems.push("FASTRR_API_TOKEN must not contain whitespace");
  // Reported by variable name and rule only - a rejected value is never echoed.
  if (problems.length > 0) throw new FastrrConfigError(`Fastrr offers are not configured: ${problems.join("; ")}`);
  const config = { baseUrl } as { baseUrl: string; token: string };
  Object.defineProperty(config, "token", { value: token, enumerable: false, writable: false });
  return config as FastrrConfig;
}
