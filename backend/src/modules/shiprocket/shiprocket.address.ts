// The delivery address of a CRM order as Shiprocket needs it. An order's address is stored in whichever shape its creator used: the CRM's own forms (the order address editor, Create Order) save
// line1 / line2 / city / state / pincode, Shopify-synced orders save address1 / address2 / city / province / zip, and some providers nest or rename them. Reading only ONE of those shapes is
// what made a fully entered CRM address look "missing". Every shape is read here, in one place, and what is missing is reported by its real name.
//
// Nothing is invented: no dummy line, no default state, no pincode taken from anywhere but the order's own saved address (its address fields, else the order's own saved pincode column).
import { unwrapAddress } from "@/lib/addressReader.js";

type Rec = Record<string, unknown>;

export interface ShipToAddress {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  /** Exactly six digits, as a STRING, so a leading zero can never be lost. */
  pincode: string;
  country: string;
}

export type ShipToResult = { ok: true; address: ShipToAddress } | { ok: false; missing: string[] };

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const first = (r: Rec, keys: string[]): string => keys.map((k) => text(r[k])).find(Boolean) ?? "";

/** Pure. Spaces / dashes inside ("400 017") are tolerated; the result is a six-digit string or "" - never a number, never padded or guessed. */
export function normalizePincode(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) && /^\d{6}$/.test(String(v)) ? String(v) : "";
  const compact = text(v).replace(/[\s-]/g, "");
  return /^\d{6}$/.test(compact) ? compact : "";
}

const LINE1 = ["line1", "address1", "line_1", "address_line_1", "addressLine1", "street_address", "address"];
const LINE2 = ["line2", "address2", "line_2", "address_line_2", "addressLine2"];
const CITY = ["city", "town"];
const STATE = ["state", "province", "region"];
const PINCODE = ["pincode", "zip", "postal_code", "postcode", "zipcode", "postalCode", "pin"];

export function readShipToAddress(rawAddress: unknown, savedPincode: string | null | undefined): ShipToResult {
  const r: Rec = typeof rawAddress === "string" && rawAddress.trim() !== "" ? { line1: rawAddress } : (unwrapAddress(rawAddress) ?? {});
  // The address line is the saved line 1; only when the order has none are the structured parts it was composed from (flat / building / street / area) used - they are saved fields, not a guess.
  const line1 = first(r, LINE1) || [first(r, ["houseNumber", "house_number", "flat", "flat_no"]), first(r, ["building", "building_name"]), first(r, ["street"]), first(r, ["area", "locality"])].filter(Boolean).join(", ");
  const city = first(r, CITY);
  const state = first(r, STATE);
  // The address's own pincode wins. The order's saved pincode column is used only when the address object carries none at all - a malformed value in the address is reported, not papered over.
  const inAddress = first(r, PINCODE);
  const pincodeSaved = inAddress || text(savedPincode);
  const pincode = normalizePincode(inAddress || savedPincode);

  const missing: string[] = [];
  if (!line1) missing.push("shipping address line 1");
  if (!city) missing.push("city");
  if (!state) missing.push("state");
  if (!pincode) missing.push(pincodeSaved ? `6-digit pincode (the saved value "${pincodeSaved.slice(0, 20)}" is not 6 digits)` : "6-digit pincode");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, address: { name: first(r, ["name", "full_name", "fullName"]), phone: first(r, ["phone", "phone_number", "phoneNumber", "mobile"]), line1, line2: first(r, LINE2), city, state, pincode, country: first(r, ["country", "country_code"]) } };
}
