// Credential redaction for WhatsApp provider errors. A provider can echo a credential inside an arbitrary error string (Meta has been seen
// repeating the access token in "Invalid OAuth access token ..." messages), and that text is stored on messages/activities, returned by the
// API and logged. Everything that leaves a provider adapter passes through here first. The useful parts of an error (HTTP status, Meta
// code/type/subcode, the human message, trace id) are kept; only credential-shaped text and the configured secrets are replaced.

const PLACEHOLDER = "[REDACTED]";

const PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${PLACEHOLDER}`],
  [/\b(access_token|client_secret|app_secret|appsecret_proof|api[_-]?key|apikey|authorization|token|secret)(\s*[=:]\s*)("?)[^\s&"',;]+/gi, `$1$2$3${PLACEHOLDER}`],
  [/\bEAA[A-Za-z0-9_-]{6,}/g, PLACEHOLDER], // Meta (Facebook) access tokens
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, PLACEHOLDER], // JWTs
  [/\bcfsk_[A-Za-z0-9_]+/g, PLACEHOLDER], // Cashfree secret keys
  [/\bshpat_[A-Za-z0-9]+/g, PLACEHOLDER], // Shopify admin tokens
];

/** `text` with credential-shaped substrings and every given exact secret replaced. Never throws. */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = String(text);
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join(PLACEHOLDER);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep copy of `value` with every string redacted (for logged / attached provider bodies). Header-like keys are blanked outright. */
export function redactDeep(value: unknown, secrets: readonly (string | null | undefined)[] = [], depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = /^(authorization|access_token|token|secret|app_secret|api[_-]?key)$/i.test(k) ? PLACEHOLDER : redactDeep(v, secrets, depth + 1);
  }
  return out;
}
