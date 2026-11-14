// The shipping address as separate spreadsheet columns, read from an abandonment's saved cart snapshot. Shared by the Abandoned Leads Excel export and the Fastrr recovery export so both
// always carry the same address columns. Nothing is guessed: a part the checkout did not provide is an empty cell, and "Full Shipping Address" is the customer's own original text when the
// source gave one (Fastrr's recovery feed), otherwise the provided parts joined in reading order.

export interface AddressColumns {
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  full: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "");

/** The provided address parts, in reading order, joined with commas (empty parts are skipped). */
export function composeAddress(parts: { line1?: unknown; line2?: unknown; landmark?: unknown; city?: unknown; state?: unknown; pincode?: unknown; country?: unknown }): string {
  return [parts.line1, parts.line2, parts.landmark, parts.city, parts.state, parts.pincode, parts.country].map(text).filter(Boolean).join(", ");
}

export const EMPTY_ADDRESS: AddressColumns = { line1: "", line2: "", landmark: "", city: "", state: "", pincode: "", country: "", full: "" };

/** Reads snapshot.shippingAddress (the parsed parts) and snapshot.shippingAddressText (the original complete text, when the source supplied it). The billing address is never substituted. */
export function addressColumnsFromSnapshot(snapshot: unknown): AddressColumns {
  const s = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
  const a = s.shippingAddress && typeof s.shippingAddress === "object" ? (s.shippingAddress as Record<string, unknown>) : {};
  const parts = { line1: text(a.line1), line2: text(a.line2), landmark: text(a.landmark), city: text(a.city), state: text(a.state), pincode: text(a.pincode), country: text(a.country) };
  const original = text(s.shippingAddressText);
  return { ...parts, full: original || composeAddress(parts) };
}
