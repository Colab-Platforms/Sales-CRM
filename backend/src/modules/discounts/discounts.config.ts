// The default discount pre-selected in Create Order and Prepaid Upgrade. It is a plain CUSTOM discount (not a coupon): change it
// here, or with DEFAULT_DISCOUNT_TYPE (FIXED | PERCENT) and DEFAULT_DISCOUNT_VALUE, without touching any code that uses it.
export interface DefaultDiscount {
  type: "FIXED" | "PERCENT";
  value: string;
}

export function loadDefaultDiscount(env: Record<string, string | undefined> = process.env): DefaultDiscount {
  const type = (env.DEFAULT_DISCOUNT_TYPE ?? "").trim().toUpperCase();
  const value = (env.DEFAULT_DISCOUNT_VALUE ?? "").trim();
  if ((type === "FIXED" || type === "PERCENT") && /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 && (type === "FIXED" || Number(value) <= 100)) return { type, value };
  return { type: "FIXED", value: "50" };
}
