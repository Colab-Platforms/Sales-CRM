// CUSTOMER CLASSIFICATION from the customer's real order count. This is deliberately separate from campaign segments (an admin's grouping of leads for a campaign): a lead can be a VIP customer and belong to
// "Diwali Mega Sale" at once, and neither value ever overwrites the other.
//   2 orders -> REPEAT      3-4 orders -> LOYAL      5 or more -> VIP      0, 1, missing or invalid -> not classified (null)
export type CustomerClassValue = "REPEAT" | "LOYAL" | "VIP";

const MAX_PLAUSIBLE_ORDERS = 100_000;

export type OrderCountParse = { state: "ok"; value: number } | { state: "missing" } | { state: "invalid"; raw: string };

/** An order count from a spreadsheet cell: whole, non-negative numbers only ("3", "3.0", "1,204"). Anything else is invalid, never guessed. */
export function parseOrderCount(raw: unknown): OrderCountParse {
  if (raw === null || raw === undefined) return { state: "missing" };
  const text = String(raw).trim();
  if (text === "" || text === "-") return { state: "missing" };
  const cleaned = text.replace(/,/g, "");
  if (!/^\d+(\.0+)?$/.test(cleaned)) return { state: "invalid", raw: text.slice(0, 40) };
  const value = Number(cleaned.replace(/\.0+$/, ""));
  if (!Number.isSafeInteger(value) || value > MAX_PLAUSIBLE_ORDERS) return { state: "invalid", raw: text.slice(0, 40) };
  return { state: "ok", value };
}

export function classifyCustomer(orderCount: number | null | undefined): CustomerClassValue | null {
  if (orderCount === null || orderCount === undefined || !Number.isInteger(orderCount) || orderCount < 2) return null;
  if (orderCount >= 5) return "VIP";
  if (orderCount >= 3) return "LOYAL";
  return "REPEAT";
}
