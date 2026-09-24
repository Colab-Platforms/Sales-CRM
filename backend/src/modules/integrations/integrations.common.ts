import { createHash } from "node:crypto";
import type { Prisma } from "../../../generated/prisma/client.js";

// Small pieces shared by the Cashfree and Shiprocket integrations. Nothing here knows about either provider's API.

export type Db = Prisma.TransactionClient;

/** What the services need to run work in a transaction. `prisma` satisfies it; tests pass a runner that reuses one rolled-back transaction. */
export interface TxRunner {
  $transaction<T>(fn: (tx: Db) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/** Serialises work on one record, so a webhook and a user action on the same order can never interleave. */
export async function advisoryLock(tx: Db, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export const sha256Hex = (input: Buffer | string): string => createHash("sha256").update(input).digest("hex");

export type ProviderName = "CASHFREE" | "SHIPROCKET";

/**
 * A failed call to a provider. `message` is safe to show: it is the provider's own error text with anything that looks
 * like a credential removed and the length capped. It never contains request headers or the request body.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: ProviderName,
    /** null when no response arrived at all (network error, timeout). */
    readonly status: number | null,
    message: string,
    /** true when trying again later could succeed (network problem, 5xx, 429). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

const CREDENTIAL_LIKE = /(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|cfsk_[A-Za-z0-9_]+|[A-Za-z0-9+/_=-]{40,})/g;

/** Provider error text made safe to store and show. */
export function safeMessage(text: unknown, fallback = "Request failed"): string {
  const raw = typeof text === "string" ? text : "";
  const cleaned = raw.replace(CREDENTIAL_LIKE, "[REDACTED]").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 300);
}

export interface HttpRequest {
  provider: ProviderName;
  fetchImpl: typeof fetch;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  json: unknown;
}

/** One JSON request. Throws ProviderHttpError for a network failure, a timeout, or any non-2xx answer. */
export async function requestJson(req: HttpRequest): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await req.fetchImpl(req.url, {
      method: req.method,
      headers: { Accept: "application/json", ...(req.body === undefined ? {} : { "Content-Type": "application/json" }), ...req.headers },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new ProviderHttpError(req.provider, null, aborted ? "The provider did not respond in time" : "Could not reach the provider", true);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const detail = body.message ?? body.error ?? body.errors ?? response.statusText;
    const message = safeMessage(typeof detail === "string" ? detail : JSON.stringify(detail));
    throw new ProviderHttpError(req.provider, response.status, message, response.status >= 500 || response.status === 429);
  }
  return { status: response.status, json };
}

export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null);

/** Reads a header from Node's header bag (values can be arrays). */
export function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A 10-digit Indian mobile number as both Cashfree and Shiprocket want it. Accepts 91XXXXXXXXXX, 0XXXXXXXXXX and XXXXXXXXXX; anything else is null. */
export function toTenDigitMobile(mobile: string | null | undefined): string | null {
  const digits = (mobile ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}
