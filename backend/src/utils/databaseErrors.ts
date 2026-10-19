import type { Response } from "express";
import STATUS_CODES from "@/utils/statusCodes.js";
import { sendResponse } from "@/utils/responseUtils.js";

// A database that is temporarily unavailable, over its provider quota, out of connections or too slow is not a bug in the request: the caller should be told plainly to try again
// later, with a 503 - and must never be sent the raw Prisma text (it names source files and the failing query) or the error object (it carries driver codes and metadata).

export type DatabaseErrorKind = "quota" | "unavailable" | "timeout";

export interface SafeDatabaseError {
  kind: DatabaseErrorKind;
  status: 503;
  /** Safe to show to any user. */
  message: string;
  retryAfterSeconds: number;
}

export const DATABASE_UNAVAILABLE_MESSAGE = "The system database is temporarily unavailable. Please try again in a few minutes.";

// Postgres class 53 = "insufficient resources" (53000 is what Neon returns when the account/project quota is exceeded; 53300 too many connections).
const RESOURCE_SQLSTATES = /^53\d{3}$/;
// Prisma: P1001/P1002 cannot reach the server, P1008 timeout, P1017 server closed the connection, P2024 pool timeout, P2028 transaction API error (expired / closed).
const UNAVAILABLE_PRISMA = new Set(["P1001", "P1002", "P1017"]);
const TIMEOUT_PRISMA = new Set(["P1008", "P2024", "P2028"]);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Every place a driver may put the SQLSTATE / provider code, without ever returning the error itself. */
function codesOf(error: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { const s = text(v); if (s) out.push(s); };
  push(error?.code);
  push(error?.meta?.code);
  push(error?.meta?.driverAdapterError?.cause?.originalCode);
  push(error?.meta?.driverAdapterError?.cause?.kind);
  push(error?.cause?.code);
  push(error?.originalCode);
  return out;
}

export function classifyDatabaseError(error: unknown): SafeDatabaseError | null {
  if (!error || typeof error !== "object") return null;
  const e = error as any;
  const message = `${text(e.message)} ${text(e.meta?.message)} ${text(e.meta?.driverAdapterError?.cause?.message)} ${text(e.cause?.message)}`;
  const codes = codesOf(e);

  if (/exceeded the quota|quota (has been )?exceeded|compute time quota|data transfer quota|storage quota/i.test(message) || codes.some((c) => c === "53000")) {
    return { kind: "quota", status: 503, message: DATABASE_UNAVAILABLE_MESSAGE, retryAfterSeconds: 300 };
  }
  if (codes.some((c) => RESOURCE_SQLSTATES.test(c)) || codes.some((c) => UNAVAILABLE_PRISMA.has(c)) || /can't reach database server|connection (terminated|closed|refused)|ECONNRESET|ECONNREFUSED|terminating connection|too many (connections|clients)|server closed the connection/i.test(message)) {
    return { kind: "unavailable", status: 503, message: DATABASE_UNAVAILABLE_MESSAGE, retryAfterSeconds: 60 };
  }
  if (codes.some((c) => TIMEOUT_PRISMA.has(c)) || /expired transaction|timed out fetching a new connection|ETIMEDOUT|timeout exceeded when trying to connect|query timeout|statement timeout/i.test(message)) {
    return { kind: "timeout", status: 503, message: DATABASE_UNAVAILABLE_MESSAGE, retryAfterSeconds: 30 };
  }
  return null;
}

/** Answers with the safe 503 (message only, no error object) and a Retry-After header. */
export function sendDatabaseUnavailable(res: Response, safe: SafeDatabaseError): void {
  res.setHeader("Retry-After", String(safe.retryAfterSeconds));
  sendResponse(res, false, null, safe.message, STATUS_CODES.SERVICE_UNAVAILABLE);
}

/** For controller catch blocks: answers with the safe 503 and returns true when `error` is a database-availability failure; otherwise does nothing and returns false. */
export function respondIfDatabaseUnavailable(res: Response, error: unknown): boolean {
  const safe = classifyDatabaseError(error);
  if (!safe) return false;
  sendDatabaseUnavailable(res, safe);
  return true;
}
