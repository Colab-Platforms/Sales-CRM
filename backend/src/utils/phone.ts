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
