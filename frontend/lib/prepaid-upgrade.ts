// LIVE PREVIEW ONLY of the Prepaid Upgrade amounts. The backend (orders.prepaid-upgrade.calc.ts) is the authority: it receives
// just the discount type and the typed value, and recomputes the discount and the payable amount itself from the real order
// total. Same integer paise rule (half-up) so the preview matches what the server will store.
export type UpgradeDiscountType = "FIXED" | "PERCENT";

export type UpgradePreview = { ok: true; discountCents: number; prepaidCents: number } | { ok: false; error: string | null };

const DECIMAL = /^\d+(\.\d{1,2})?$/;

/** error === null means "nothing typed yet" (no message, but not valid either). */
export function previewUpgrade(originalCents: number, type: UpgradeDiscountType, raw: string): UpgradePreview {
  const text = raw.trim();
  if (text === "") return { ok: false, error: null };
  if (text.startsWith("-")) return { ok: false, error: "Discount cannot be negative" };
  if (!DECIMAL.test(text)) return { ok: false, error: "Enter a valid discount" };
  const hundredths = Math.round(Number(text) * 100);
  if (hundredths <= 0) return { ok: false, error: "Discount must be greater than 0" };
  let discountCents: number;
  if (type === "FIXED") {
    discountCents = hundredths;
  } else {
    if (hundredths > 10_000) return { ok: false, error: "Percentage cannot exceed 100" };
    discountCents = Math.round((originalCents * hundredths) / 10_000);
    if (discountCents <= 0) return { ok: false, error: "Discount is too small to apply to this amount" };
  }
  if (discountCents >= originalCents) return { ok: false, error: "Discount cannot be greater than or equal to the order amount." };
  return { ok: true, discountCents, prepaidCents: originalCents - discountCents };
}
