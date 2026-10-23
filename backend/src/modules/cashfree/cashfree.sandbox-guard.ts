// FAIL-FAST for a Cashfree SANDBOX test run. Active only when the process was started in sandbox mode (CRM_SANDBOX_MODE=true, set by backend/sandbox/start-sandbox.ps1 in the process environment - never in a
// .env file), so the normal production process is not affected in any way. It refuses to run when anything could reach production:
//   - the Cashfree environment is not EXPLICITLY sandbox, or a production URL / production override is configured;
//   - the database is not obviously a throw-away one (host loopback, or a database name containing sandbox / test / iso) or is a known production host;
//   - live WhatsApp or Shopify writes are switched on, or the webhook address is a known production backend;
//   - the person has not confirmed the credentials are the SANDBOX pair (Cashfree gives no reliable way to tell the two apart offline).
// Problems are listed by variable NAME and rule only; a value (credential, connection string) is never echoed.

type Env = Record<string, string | undefined>;

/** Neon endpoints of the live CRM database. Add more with CRM_PRODUCTION_DB_HOSTS (comma separated). */
const BUILT_IN_PRODUCTION_DB_HOSTS = ["ep-gentle-rice-b3jims4e"];

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
const THROWAWAY_DB_NAME = /(sandbox|test|iso)/i;

const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const isTrue = (value: string | undefined) => (value ?? "").trim().toLowerCase() === "true";

export const isSandboxProcess = (env: Env = process.env): boolean => isTrue(env.CRM_SANDBOX_MODE);

function parseDb(raw: string | undefined): { host: string; name: string } | null {
  try {
    const url = new URL((raw ?? "").trim());
    return { host: url.hostname.toLowerCase(), name: decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase() };
  } catch {
    return null;
  }
}

/** The reasons a sandbox run must not start, as variable-name-only messages. Empty when it is safe (or when this is not a sandbox process). */
export function sandboxProblems(env: Env = process.env): string[] {
  if (!isSandboxProcess(env)) return [];
  const problems: string[] = [];

  if ((env.CASHFREE_ENV ?? "").trim().toLowerCase() !== "sandbox") problems.push("CASHFREE_ENV must be explicitly sandbox in a sandbox run");
  if (isTrue(env.CASHFREE_UPI_QR_ALLOW_PRODUCTION)) problems.push("CASHFREE_UPI_QR_ALLOW_PRODUCTION must not be true in a sandbox run");
  for (const name of ["CASHFREE_API_URL", "CASHFREE_BASE_URL"] as const) {
    if (/api\.cashfree\.com/i.test(env[name] ?? "")) problems.push(`${name} points at the production Cashfree host`);
  }
  if (!isTrue(env.CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED)) problems.push("CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED=true is required (confirm CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET are the SANDBOX keys)");

  const productionDbHosts = [...BUILT_IN_PRODUCTION_DB_HOSTS, ...list(env.CRM_PRODUCTION_DB_HOSTS)];
  for (const name of ["DATABASE_URL", "QUEUE_DATABASE_URL"] as const) {
    const raw = env[name];
    if (name === "QUEUE_DATABASE_URL" && !(raw ?? "").trim()) continue;
    const db = parseDb(raw);
    if (!db) {
      problems.push(`${name} is missing or is not a database URL`);
      continue;
    }
    if (productionDbHosts.some((h) => db.host.includes(h))) problems.push(`${name} points at a production database host`);
    else if (!LOOPBACK.test(db.host) && !THROWAWAY_DB_NAME.test(db.name)) problems.push(`${name} must be a local database or one whose name contains sandbox, test or iso`);
  }

  if ((env.WHATSAPP_PROVIDER ?? "").trim()) problems.push("WHATSAPP_PROVIDER must be unset in a sandbox run (no WhatsApp provider may be active)");
  if (isTrue(env.SHOPIFY_SYNC_ENABLED)) problems.push("SHOPIFY_SYNC_ENABLED must not be true in a sandbox run");

  const publicUrl = (env.PUBLIC_BACKEND_URL ?? "").trim();
  if (!/^https:\/\/[^\s/]+/i.test(publicUrl)) problems.push("PUBLIC_BACKEND_URL must be the public https address of the SANDBOX backend (Cashfree posts webhooks there)");
  else {
    let host = "";
    try {
      host = new URL(publicUrl).hostname.toLowerCase();
    } catch {
      /* reported above */
    }
    if (list(env.CRM_PRODUCTION_BACKEND_HOSTS).some((h) => host === h || host.endsWith(`.${h}`))) problems.push("PUBLIC_BACKEND_URL is the production backend");
  }
  if (!isTrue(env.CASHFREE_ENABLED)) problems.push("CASHFREE_ENABLED must be true");
  if (!isTrue(env.CASHFREE_UPI_QR_ENABLED)) problems.push("CASHFREE_UPI_QR_ENABLED must be true");
  return problems;
}

/** Throws (naming variables only) when a sandbox process is misconfigured. A normal, non-sandbox process is never affected. */
export function assertSandboxProcess(env: Env = process.env): void {
  const problems = sandboxProblems(env);
  if (problems.length > 0) throw new Error(`Sandbox run refused: ${problems.join("; ")}`);
}
