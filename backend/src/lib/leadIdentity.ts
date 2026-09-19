// Contact-detail normalization used to recognise that two records are the same person.
// Shared so that every place that creates or matches leads (imports, calls, order booking)
// agrees on one rule.

// Numbers without a country code are treated as belonging to this country. The store is Indian (INR).
const DEFAULT_COUNTRY_CODE = "91";

/** Canonical "+<country><number>" form, or null if the input is not a plausible phone number. */
export function normalizeMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  const international = trimmed.startsWith("+") || digits.startsWith("00");
  // Leading zeros are a trunk or international prefix, not part of the number.
  const significant = digits.replace(/^0+/, "");
  if (!significant) return null;

  if (!international && significant.length === 10) return `+${DEFAULT_COUNTRY_CODE}${significant}`;
  if (significant.length >= 8 && significant.length <= 15) return `+${significant}`;
  return null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
