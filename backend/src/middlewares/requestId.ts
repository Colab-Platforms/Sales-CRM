import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

// Correlation id for one request: an inbound X-Request-Id is kept only if it is short and plain (it ends up in logs and a
// response header), otherwise a fresh one is made. Stored on res.locals so no Request typing has to change.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header("x-request-id");
  const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

// One log line for a rejected authentication/authorization, safe to keep: method, route without its query string, status,
// whether an Authorization header was sent at all (a boolean - never its value), and the correlation id. No token, cookie or body.
export function describeAuthFailure(req: Request, res: Response, status: number, message: string): string {
  // Defensive: the error handler can be reached with a partial request (tests, aborted sockets); logging must never throw.
  const route = (req.originalUrl ?? req.url ?? "").split("?")[0];
  const sentAuthHeader = Boolean(req.headers?.authorization);
  return `[auth] ${status} ${req.method} ${route} reason="${message}" authHeader=${sentAuthHeader} requestId=${res.locals?.requestId ?? "-"}`;
}
