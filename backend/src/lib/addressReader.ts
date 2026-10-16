
// How a stored address of any shape (CRM order, Shopify-synced order, Shiprocket Checkout / Fastrr snapshot,
// nested provider payload) is read. Every manual-order entry point (WhatsApp -> Create Order, Lead page -> Create Order, abandoned checkout) goes through here, so a field-name quirk is fixed
// once. Nothing is invented: a value that does not look like what its field holds (a 40-word place description in "pincode") is left empty for the person to enter, never copied in.

export type AddressSource = "ORDER" | "CHECKOUT";

export interface ResolvedAddress {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  houseNumber: string;
  building: string;
  area: string;
  street: string;
  landmark: string;
  addressType: string;
  country: string;
  /** Delivery instructions the customer gave ("leave with the guard"), kept instead of dropped. */
  deliveryInstructions: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 255): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const firstOf = (r: Rec, keys: string[], max = 255) => keys.map((k) => text(r[k], max)).find(Boolean) ?? "";

/** Keys that hold the address itself when a provider wraps it: { shippingAddress: {...} }, { address: {...} }, { delivery: { address: {...} } }. */
const WRAPPERS = ["shippingAddress", "shipping_address", "deliveryAddress", "delivery_address", "address", "shipping", "location"];
const LEAF_KEYS = ["line1", "address1", "line_1", "address_line_1", "addressLine1", "street_address", "houseNumber", "house_number", "pincode", "zip", "postal_code", "postcode", "zipcode", "postalCode", "city", "area", "locality"];

/** Finds the object that actually holds the address fields (descends through provider wrappers, max 3 levels). */
export function unwrapAddress(raw: unknown, depth = 0): Rec | null {
  if (!isRec(raw)) return null;
  if (LEAF_KEYS.some((k) => raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== "object")) return raw;
  if (depth >= 3) return raw;
  for (const key of WRAPPERS) {
    const inner = unwrapAddress(raw[key], depth + 1);
    if (inner) return inner;
  }
  return raw;
}

/** Indian PIN: six digits, not starting 0; spaces/dashes inside are tolerated ("400 053"), anything else (a place description) is not a pincode. */
export function cleanPincode(v: unknown): string {
  const compact = text(v, 20).replace(/[\s-]/g, "");
  return /^[1-9]\d{5}$/.test(compact) ? compact : "";
}

/** A city or state is a short name: no digits, no comma-separated address, not a sentence. Anything longer is a place description and does not belong here. */
export function cleanPlace(v: unknown): string {
  const t = text(v, 120);
  if (!t || /\d/.test(t) || t.includes(",") || t.length > 50 || t.split(" ").length > 5) return "";
  return t;
}

/** Reads any stored/provider address shape into the form's shape. Null when it has nothing usable. */
export function readAddressRecord(raw: unknown, fallbackPincode?: string | null): ResolvedAddress | null {
  const bare = typeof raw === "string" && raw.trim() !== "" ? ({ line1: raw } as Rec) : null;
  const r = bare ?? unwrapAddress(raw);
  if (!r) return null;
  const name = firstOf(r, ["name", "full_name", "fullName"]) || [text(r.firstName ?? r.first_name), text(r.lastName ?? r.last_name)].filter(Boolean).join(" ");
  const address: ResolvedAddress = {
    name,
    phone: firstOf(r, ["phone", "phone_number", "phoneNumber", "mobile", "contact"], 30),
    line1: firstOf(r, ["line1", "address1", "line_1", "address_line_1", "addressLine1", "street_address", "address"]),
    line2: firstOf(r, ["line2", "address2", "line_2", "address_line_2", "addressLine2"]),
    city: cleanPlace(firstOf(r, ["city", "town"], 120)),
    state: cleanPlace(firstOf(r, ["state", "province", "region"], 120)),
    pincode: cleanPincode(firstOf(r, ["pincode", "zip", "postal_code", "postcode", "zipcode", "postalCode", "pin"], 20)) || cleanPincode(fallbackPincode),
    country: firstOf(r, ["country", "country_code"], 60),
    houseNumber: firstOf(r, ["houseNumber", "house_number", "flat", "flat_no", "apartment"]),
    building: firstOf(r, ["building", "building_name", "apartment_name"]),
    area: firstOf(r, ["area", "locality", "sublocality", "neighbourhood"]),
    street: firstOf(r, ["street"]),
    landmark: firstOf(r, ["landmark"], 160),
    addressType: ["HOME", "WORK", "OTHER"].find((t) => t === firstOf(r, ["addressType", "address_type"]).toUpperCase()) ?? "",
    deliveryInstructions: firstOf(r, ["deliveryInstructions", "delivery_instructions", "instructions", "note", "notes"], 255),
  };
  const usable = address.line1 || address.houseNumber || address.area || address.city || address.pincode;
  return usable ? address : null;
}

