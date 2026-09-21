// Shiprocket connection settings, read from the backend environment only. Nothing here is ever sent to the frontend.
//
// Use an API user created in the Shiprocket panel (API > Configure > Create API user), not the main account login.

export const DEFAULT_API_URL = "https://apiv2.shiprocket.in/v1/external";

export interface ShiprocketConfig {
  readonly baseUrl: string;
  readonly email: string;
  /** Non-enumerable so it never appears in JSON.stringify, console.log or util.inspect. */
  readonly password: string;
  /** The saved pickup location's name, exactly as it appears in the Shiprocket panel. */
  readonly pickupLocation: string;
}

export class ShiprocketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiprocketConfigError";
  }
}

type Env = Record<string, string | undefined>;

const flag = (env: Env) => (env.SHIPROCKET_ENABLED ?? "").trim().toLowerCase() === "true";

/** Shiprocket stays fully off unless SHIPROCKET_ENABLED=true. */
export const isShiprocketEnabled = (env: Env = process.env): boolean => flag(env);

function hide(config: object, key: string, value: string) {
  Object.defineProperty(config, key, { value, enumerable: false, writable: false });
}

// Problems are reported by variable NAME and rule only; a rejected value is never echoed.
export function loadShiprocketConfig(env: Env = process.env): ShiprocketConfig {
  if (!flag(env)) throw new ShiprocketConfigError("Shiprocket is not enabled (SHIPROCKET_ENABLED is not true)");
  const problems: string[] = [];

  // The login credentials are only ever sent to a Shiprocket host, whatever this variable says.
  const baseUrl = (env.SHIPROCKET_API_URL ?? DEFAULT_API_URL).trim().replace(/\/+$/, "");
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || !(url.hostname === "shiprocket.in" || url.hostname.endsWith(".shiprocket.in"))) problems.push("SHIPROCKET_API_URL must be an https URL on shiprocket.in");
  } catch {
    problems.push("SHIPROCKET_API_URL must be a valid URL");
  }

  const email = (env.SHIPROCKET_EMAIL ?? "").trim();
  if (!email) problems.push("SHIPROCKET_EMAIL is not set");
  else if (!email.includes("@") || /\s/.test(email)) problems.push("SHIPROCKET_EMAIL must be an email address");

  const password = env.SHIPROCKET_PASSWORD ?? "";
  if (!password.trim()) problems.push("SHIPROCKET_PASSWORD is not set");

  const pickupLocation = (env.SHIPROCKET_PICKUP_LOCATION ?? "").trim();
  if (!pickupLocation) problems.push("SHIPROCKET_PICKUP_LOCATION is not set");

  if (problems.length > 0) throw new ShiprocketConfigError(`Shiprocket is misconfigured: ${problems.join("; ")}`);

  const config = { baseUrl, email, pickupLocation } as ShiprocketConfig;
  hide(config, "password", password);
  return config;
}

/**
 * What the webhook endpoint needs. Shiprocket lets you attach a security token to a webhook, which it sends as the
 * x-api-key header; the CRM requires one, because without it anyone could post a status update.
 */
export function loadShiprocketWebhookConfig(env: Env = process.env): { readonly token: string } | null {
  if (!flag(env)) return null;
  const token = (env.SHIPROCKET_WEBHOOK_SECRET ?? "").trim();
  if (!token) return null;
  const config = {} as { token: string };
  hide(config, "token", token);
  return config;
}
