import { asRecord, safeMessage } from "../integrations/integrations.common.js";
import { ABANDONED_CARTS_PATH, FASTRR_SOURCE, type FastrrRecoveryConfig } from "./fastrr-recovery.config.js";

// The only place that talks to the Fastrr reporting API. READ-ONLY: one GET endpoint,
//   GET {base}/api/ve1/dashboard-service/report/abandon-carts?page=<n>&from=YYYY-MM-DD&to=YYYY-MM-DD&source=fastrr
// with the `x-auth` and `authentication-info` headers; the carts are in data.abandonCarts[].
//
// PAGINATION IS NOT ASSUMED. The response's paging fields were not captured, so the loop never relies on a page size. It reads page 0, 1, 2 ... and stops only when
//   (a) a page has no carts (the normal end),
//   (b) the response itself says it is the last page / how many there are (totals are honoured when present, never required), or
//   (c) a page returns only carts already seen (an endpoint that ignores `page` would otherwise loop for ever).
// If the page ceiling is reached first the result is marked complete=false and the caller refuses to import from it - a partial read is never presented as the whole range.

export const MAX_PAGES = 200;
export const MAX_RANGE_DAYS = 31;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;

export type FastrrErrorCode = "AUTH" | "RATE_LIMIT" | "TIMEOUT" | "NETWORK" | "SERVER" | "MALFORMED" | "BAD_REQUEST";

export class FastrrRecoveryError extends Error {
  constructor(
    readonly code: FastrrErrorCode,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "FastrrRecoveryError";
  }
}

export interface FetchCartsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPages?: number;
  /** Replaced in tests so retries do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchedCarts {
  /** Every cart record exactly as Fastrr returned it (not yet validated). */
  records: unknown[];
  pages: number;
  /** false = the read stopped at the page ceiling, so the list may be short. */
  complete: boolean;
  /** Why the loop stopped. */
  stoppedBecause: "EMPTY_PAGE" | "LAST_PAGE_FLAG" | "TOTAL_REACHED" | "REPEATED_PAGE" | "PAGE_LIMIT";
  /** The total Fastrr reported, when its response carried one. */
  reportedTotal: number | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD strings, from <= to, at most MAX_RANGE_DAYS apart. Returns the problem, or null. */
export function validateRange(from: string, to: string): string | null {
  if (!DAY.test(from) || !DAY.test(to)) return "Dates must be in YYYY-MM-DD format";
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || new Date(a).toISOString().slice(0, 10) !== from || new Date(b).toISOString().slice(0, 10) !== to) return "Dates are not valid calendar dates";
  if (a > b) return "From date must not be after To date";
  if ((b - a) / 86_400_000 + 1 > MAX_RANGE_DAYS) return `Choose a range of at most ${MAX_RANGE_DAYS} days`;
  return null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The cart array of one response, or null when the response is not the documented shape. */
export function readCartArray(json: unknown): unknown[] | null {
  const data = asRecord(asRecord(json).data);
  return Array.isArray(data.abandonCarts) ? (data.abandonCarts as unknown[]) : null;
}

function readNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Whatever the response says about its own size / last page - every field is optional and none is required. */
export function readPaging(json: unknown): { total: number | null; last: boolean | null; totalPages: number | null } {
  const root = asRecord(json);
  const data = asRecord(root.data);
  const sources = [data, asRecord(data.pagination), asRecord(data.paging), asRecord(root.pagination), root];
  let total: number | null = null;
  let totalPages: number | null = null;
  let last: boolean | null = null;
  for (const s of sources) {
    for (const k of ["total", "totalCount", "total_count", "totalRecords", "totalElements"]) total ??= readNumber(s[k]);
    for (const k of ["totalPages", "total_pages", "pageCount"]) totalPages ??= readNumber(s[k]);
    for (const k of ["last", "isLast", "isLastPage"]) if (typeof s[k] === "boolean") last ??= s[k] as boolean;
    if (typeof s.hasNext === "boolean") last ??= !s.hasNext;
    if (typeof s.hasMore === "boolean") last ??= !s.hasMore;
  }
  return { total, last, totalPages };
}

function cartKey(record: unknown): string | null {
  const r = asRecord(record);
  const v = r.cart ?? r.cartId ?? r.cart_id;
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}

/** One page, with bounded retries for a timeout, a network failure, a 5xx and a 429. An authentication failure or a malformed body is never retried. */
async function fetchPage(config: FastrrRecoveryConfig, from: string, to: string, page: number, options: FetchCartsOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const url = `${config.baseUrl}${ABANDONED_CARTS_PATH}?${new URLSearchParams({ page: String(page), from, to, source: FASTRR_SOURCE }).toString()}`;
  let lastError: FastrrRecoveryError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let retryAfterMs: number | null = null;
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json", "x-auth": config.authToken, "authentication-info": config.authInfo }, signal: controller.signal });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new FastrrRecoveryError(aborted ? "TIMEOUT" : "NETWORK", aborted ? "Fastrr did not respond in time" : "Could not reach Fastrr");
      }
      if (response.status === 401 || response.status === 403) throw new FastrrRecoveryError("AUTH", "Fastrr rejected the credentials - the token may have expired", response.status);
      if (response.status === 429) {
        const header = Number(response.headers.get("retry-after"));
        retryAfterMs = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 30_000) : null;
        throw new FastrrRecoveryError("RATE_LIMIT", "Fastrr is rate limiting requests", 429);
      }
      if (response.status >= 500) throw new FastrrRecoveryError("SERVER", `Fastrr returned an error (HTTP ${response.status})`, response.status);
      if (!response.ok) throw new FastrrRecoveryError("BAD_REQUEST", `Fastrr rejected the request (HTTP ${response.status})`, response.status);
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new FastrrRecoveryError("MALFORMED", "Fastrr returned a response that is not valid JSON", response.status);
      }
      if (readCartArray(json) === null) throw new FastrrRecoveryError("MALFORMED", "Fastrr's response did not contain data.abandonCarts", response.status);
      return json;
    } catch (error) {
      const err = error instanceof FastrrRecoveryError ? error : new FastrrRecoveryError("NETWORK", safeMessage(error instanceof Error ? error.message : String(error)));
      const retryable = err.code === "TIMEOUT" || err.code === "NETWORK" || err.code === "SERVER" || err.code === "RATE_LIMIT";
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 8_000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new FastrrRecoveryError("NETWORK", "Could not reach Fastrr");
}

/** Every abandoned cart Fastrr lists for [from, to] (calendar days as the dashboard filters them), across all pages. */
export async function fetchAbandonedCarts(config: FastrrRecoveryConfig, from: string, to: string, options: FetchCartsOptions = {}): Promise<FetchedCarts> {
  const problem = validateRange(from, to);
  if (problem) throw new FastrrRecoveryError("BAD_REQUEST", problem);
  const maxPages = options.maxPages ?? MAX_PAGES;
  const records: unknown[] = [];
  const seen = new Set<string>();
  let reportedTotal: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const json = await fetchPage(config, from, to, page, options);
    const batch = readCartArray(json)!;
    const paging = readPaging(json);
    if (paging.total !== null) reportedTotal = paging.total;
    if (batch.length === 0) return { records, pages: page + 1, complete: true, stoppedBecause: "EMPTY_PAGE", reportedTotal };

    // A page of nothing but carts we already hold means the endpoint is not advancing (or has wrapped round): stop rather than loop.
    const keys = batch.map(cartKey);
    const fresh = keys.filter((k) => k === null || !seen.has(k)).length;
    for (const k of keys) if (k) seen.add(k);
    if (fresh === 0) return { records, pages: page + 1, complete: true, stoppedBecause: "REPEATED_PAGE", reportedTotal };
    records.push(...batch);

    if (paging.last === true) return { records, pages: page + 1, complete: true, stoppedBecause: "LAST_PAGE_FLAG", reportedTotal };
    if (paging.totalPages !== null && page + 1 >= paging.totalPages) return { records, pages: page + 1, complete: true, stoppedBecause: "LAST_PAGE_FLAG", reportedTotal };
    if (reportedTotal !== null && records.length >= reportedTotal) return { records, pages: page + 1, complete: true, stoppedBecause: "TOTAL_REACHED", reportedTotal };
  }
  return { records, pages: maxPages, complete: false, stoppedBecause: "PAGE_LIMIT", reportedTotal };
}
