export function normalizeMobile(mobile: string | undefined | null): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

export function normalizeEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
