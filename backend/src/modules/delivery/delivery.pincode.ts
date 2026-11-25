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
import { logger } from "@/utils/logger.js";
import { ShiprocketClient } from "../shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../shiprocket/shiprocket.config.js";

export const PINCODE_PATTERN = /^[1-9]\d{5}$/;
const API = "https://api.postalpincode.in/pincode/";
const TTL_MS = 24 * 60 * 60 * 1000;
/** A pincode's city and state almost never change: when the live lookup is down, an answer up to this old is still better than none. */
const STALE_OK_MS = 30 * TTL_MS;
const TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 400;

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
  /** Why the lookup was unavailable (TIMEOUT, NETWORK, HTTP_429, BAD_RESPONSE ...). For diagnostics only; never contains customer data. */
  reason?: string;
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

/** A second, independent source for a pincode's city and state, used only when the main directory is unavailable. null = it does not know this pincode; a throw = it is unavailable too. */
export type PincodeFallback = (pincode: string) => Promise<{ city: string; state: string; areas: string[] } | null>;

/** Shiprocket's own locality data, through the existing integration (same credentials). Not configured -> no fallback. */
const shiprocketFallback: PincodeFallback = async (pincode) => {
  let config;
  try {
    config = loadShiprocketConfig();
  } catch {
    throw new Error("NOT_CONFIGURED");
  }
  return new ShiprocketClient(config).getPostcodeDetails(pincode);
};

/** Why a request to the directory failed, as a short code (no URLs, no response bodies, no customer data). */
export function failureReason(error: unknown): string {
  const e = error as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "TIMEOUT";
  const http = /^HTTP (\d{3})$/.exec(String(e?.message ?? ""));
  if (http) return `HTTP_${http[1]}`;
  if (e?.name === "SyntaxError") return "BAD_RESPONSE";
  return "NETWORK";
}
/** Worth trying again right away: timeouts, network faults, 429 and 5xx. A 4xx other than 429 will not change. */
const transient = (reason: string) => reason === "TIMEOUT" || reason === "NETWORK" || reason === "BAD_RESPONSE" || reason === "HTTP_429" || /^HTTP_5/.test(reason);

const lastLogged = new Map<string, number>();
export const clearPincodeLogThrottle = () => lastLogged.clear();

export interface LookupDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Second source when the directory is down. Default: Shiprocket (real use only; a caller that injects its own fetch gets none unless it passes one). */
  fallback?: PincodeFallback | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export async function lookupPincode(pincode: string, deps: LookupDeps = {}): Promise<PincodeLookup> {
  if (!PINCODE_PATTERN.test(pincode)) return { pincode, status: "invalid", city: null, state: null, areas: [], message: "Please enter a valid 6-digit Indian pincode." };
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(pincode);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((m: string) => logger.warn(m));

  // 1. the directory, with one more try for a transient fault
  let value: PincodeLookup | null = null;
  let reason = "NETWORK";
  let attempts = 0;
  for (let attempt = 0; attempt < 2 && !value; attempt++) {
    attempts += 1;
    try {
      const response = await fetchImpl(`${API}${pincode}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parsePincodeResponse(pincode, await response.json());
      if (parsed.status === "unavailable") {
        reason = "BAD_RESPONSE";
        throw new Error("unclear");
      }
      value = parsed;
    } catch (error) {
      if ((error as Error).message !== "unclear") reason = failureReason(error);
      if (!transient(reason) || attempt === 1) break;
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (value) {
    cache.set(pincode, { at: now, value });
    return value;
  }

  // 2. a second source, only to FILL IN city and state - it never says a pincode is invalid
  const fallback = deps.fallback !== undefined ? deps.fallback : deps.fetchImpl ? null : shiprocketFallback;
  let fallbackNote = "none";
  if (fallback) {
    try {
      const found = await fallback(pincode);
      if (found) {
        const filled: PincodeLookup = { pincode, status: "valid", city: found.city, state: found.state, areas: found.areas, message: null };
        cache.set(pincode, { at: now, value: filled });
        fallbackNote = "used";
        throttledLog(log, now, `Pincode directory unavailable (${reason}, ${attempts} attempt(s)); city/state taken from the courier's locality data instead`, reason + ":fallback-ok");
        return filled;
      }
      fallbackNote = "unknown-pincode";
    } catch (error) {
      fallbackNote = (error as Error)?.message === "NOT_CONFIGURED" ? "not-configured" : "failed";
    }
  }

  // 3. an older answer for this very pincode (city and state barely ever change)
  if (hit && now - hit.at < STALE_OK_MS) {
    throttledLog(log, now, `Pincode directory unavailable (${reason}, ${attempts} attempt(s), fallback ${fallbackNote}); served an earlier answer`, reason + ":stale");
    return hit.value;
  }

  // 4. honestly unavailable: the form lets the order continue and the courier checks the address again. Never reported as invalid or serviceable.
  throttledLog(log, now, `Pincode directory unavailable: reason=${reason} attempts=${attempts} fallback=${fallbackNote}`, reason + ":" + fallbackNote);
  return { pincode, status: "unavailable", city: null, state: null, areas: [], message: "Could not check this pincode right now. You can continue - it will be checked again by the courier.", reason };
}

/** One log line per reason per minute, so an outage cannot flood the log. */
function throttledLog(log: (m: string) => void, now: number, message: string, key: string): void {
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < 60_000) return;
  lastLogged.set(key, now);
  log(message);
}
