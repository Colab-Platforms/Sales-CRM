/**
 * Best-effort phone normalization.
 *
 * NOTE: the exact algorithm originally used to populate `leads.normalized_mobile`
 * in the live database is unknown (it was not created by this codebase). This
 * strips all non-digit characters and, for numbers longer than 10 digits,
 * assumes a leading country code and keeps the last 10 digits (India mobile
 * format). Verify this matches real data before relying on it for anything
 * beyond read-only lookups.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const digitsOnly = String(raw).replace(/\D/g, "");
  if (!digitsOnly) return null;

  if (digitsOnly.length > 10) {
    return digitsOnly.slice(-10);
  }

  return digitsOnly;
}

/**
 * Candidate stored forms of a phone number, for matching against
 * `leads.normalized_mobile` (and similar columns).
 *
 * Why this exists: leads are written by `normalizeMobile` (utils/normalize.ts),
 * which keeps ALL digits (a lead saved as "+91 98765 43210" is stored as
 * "919876543210"), whereas `normalizePhone` above keeps only the last 10. An
 * exact `normalizePhone()` lookup therefore misses leads saved with a country
 * code. Rather than add a third competing normalizer, this returns every
 * plausible stored form derived from the two existing ones:
 *
 *   - the full digit string as given          (matches leads saved verbatim)
 *   - `normalizePhone()` (last 10 digits)     (matches leads saved without a country code)
 *   - "91" + last 10, ONLY for 10-digit numbers starting 6-9 (Indian mobile
 *     range)                                  (matches Indian leads saved with +91)
 *
 * Numbers with fewer than 10 digits return no candidates: short codes and
 * extensions must never be matched to a lead. Non-Indian numbers are not given
 * the "91" variant.
 */
export function buildMobileLookupCandidates(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];

  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return [];

  const candidates = new Set<string>([digits]);

  const local = normalizePhone(digits);
  if (local && local.length === 10) {
    candidates.add(local);
    if (/^[6-9]/.test(local)) candidates.add(`91${local}`);
  }

  return [...candidates];
}
