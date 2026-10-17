// Pure safety helpers for duplicate-leads-report.ts - kept free of any I/O so they can be unit-tested
// without a database. Nothing here ever returns or throws a value that contains the connection string.

export type ParsedTarget = { ok: true; host: string; db: string } | { ok: false };

/** Host and database name only. A malformed URL yields `{ ok: false }` - the underlying error (which can
 *  carry the rejected input, i.e. the password) is swallowed here and never escapes. */
export function parseTarget(connectionString: string | undefined): ParsedTarget {
  if (!connectionString) return { ok: false };
  try {
    const url = new URL(connectionString);
    if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname) return { ok: false };
    return { ok: true, host: url.hostname.toLowerCase(), db: url.pathname.replace(/^\//, "") };
  } catch {
    return { ok: false };
  }
}

/** Neon's pooled and direct endpoints are the same database; "-pooler" is not a different target. */
const withoutPooler = (host: string) => host.toLowerCase().replace("-pooler", "");

/** EXACT hostname equality (case-insensitive, pooled/direct treated as one) - never a substring. */
export function hostMatches(actualHost: string, expectedHost: string | undefined): boolean {
  if (!expectedHost) return false;
  const expected = withoutPooler(expectedHost.trim());
  return expected.length > 0 && withoutPooler(actualHost) === expected;
}

/** "+919876543210" -> "+91*******3210": only the last four digits survive. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  const visible = digits.slice(-4);
  const prefix = phone.startsWith("+") ? "+" : "";
  return `${prefix}${"*".repeat(digits.length - 4)}${visible}`;
}

/** "Komal" -> "K***": a customer's name is never printed in full. */
export function maskName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? `${[...trimmed][0]}***` : null;
}

export function maskEmailKey(key: string): string {
  return key.replace(/^email:(.).*@/, "email:$1***@");
}

/** Display form of a group key ("phone:+91..." / "email:...") with personal data masked. */
export function maskGroupKey(key: string): string {
  return key.startsWith("phone:") ? `phone:${maskPhone(key.slice("phone:".length))}` : maskEmailKey(key);
}
