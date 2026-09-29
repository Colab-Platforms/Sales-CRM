// Indian pincode lookup for the Create Order form. The pincode is validated against India Post data through the public
// postalpincode.in API (a free service that republishes India Post's directory - it is NOT operated by India Post; the
// official source, data.gov.in, needs an API key this project does not have). Nothing is hardcoded.
//
// Three honest outcomes:
//   valid       the directory has post offices for this pincode -> city (district) and state are returned
//   invalid     the directory answered and has no such pincode
//   unavailable the directory could not be reached / answered nonsense - the form must NOT treat that as "invalid"
//
// Results (including "invalid") are cached in memory for a day: a pincode's existence rarely changes and this keeps the
// form from calling a third party on every keystroke or every order.
import { asRecord } from "../integrations/integrations.common.js";

export const PINCODE_PATTERN = /^[1-9]\d{5}$/;
const API = "https://api.postalpincode.in/pincode/";
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;

export type PincodeStatus = "valid" | "invalid" | "unavailable";

export interface PincodeLookup {
  pincode: string;
  status: PincodeStatus;
  /** The postal district (what an address calls the city), e.g. "Mumbai". */
  city: string | null;
  state: string | null;
  /** A few post office names, for the salesperson to recognise the area. */
  areas: string[];
  message: string | null;
}

interface CacheEntry { at: number; value: PincodeLookup }
const cache = new Map<string, CacheEntry>();
export const clearPincodeCache = () => cache.clear();

const title = (s: string) => s.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function parsePincodeResponse(pincode: string, json: unknown): PincodeLookup {
  const first = asRecord(Array.isArray(json) ? json[0] : json);
  const offices = Array.isArray(first.PostOffice) ? first.PostOffice.map(asRecord) : [];
  if (offices.length === 0) {
    // The directory's own "no records found" answer is a definitive invalid; anything else is unclear.
    const definitive = /no records found/i.test(String(first.Message ?? "")) || String(first.Status ?? "").toLowerCase() === "404" || String(first.Status ?? "").toLowerCase() === "error";
    return definitive
      ? { pincode, status: "invalid", city: null, state: null, areas: [], message: "Please enter a valid 6-digit Indian pincode." }
      : { pincode, status: "unavailable", city: null, state: null, areas: [], message: "The pincode directory gave an unclear answer." };
  }
  const count = (key: string) => {
    const tally = new Map<string, number>();
    for (const o of offices) { const v = String(o[key] ?? "").trim(); if (v) tally.set(v, (tally.get(v) ?? 0) + 1); }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const city = count("District") ?? count("Block");
  const state = count("State");
  const areas = [...new Set(offices.map((o) => String(o.Name ?? "").trim()).filter(Boolean))].slice(0, 6);
  return { pincode, status: "valid", city: city ? title(city) : null, state: state ? title(state) : null, areas, message: null };
}

export async function lookupPincode(pincode: string, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<PincodeLookup> {
  if (!PINCODE_PATTERN.test(pincode)) return { pincode, status: "invalid", city: null, state: null, areas: [], message: "Please enter a valid 6-digit Indian pincode." };
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(pincode);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const fetchImpl = deps.fetchImpl ?? fetch;
  let value: PincodeLookup;
  try {
    const response = await fetchImpl(`${API}${pincode}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    value = parsePincodeResponse(pincode, await response.json());
  } catch {
    // Not cached: the next attempt should try again.
    return { pincode, status: "unavailable", city: null, state: null, areas: [], message: "Could not check this pincode right now. You can continue - it will be checked again by the courier." };
  }
  if (value.status !== "unavailable") cache.set(pincode, { at: now, value });
  return value;
}
