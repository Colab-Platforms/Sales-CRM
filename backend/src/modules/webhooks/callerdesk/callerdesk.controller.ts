import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { createCallerDeskWebhookService, type CallerDeskWebhookService } from "./callerdesk.service.js";
import { createPrismaCallEventStore } from "./callerdesk.store.js";
import { DEFAULT_TIMESTAMP_UTC_OFFSET } from "./callerdesk.payload.js";

/**
 * SECURITY - read before exposing this endpoint.
 *
 * CallerDesk's webhook documentation describes NO signature, secret, auth header or IP
 * allowlist (only a public HTTPS URL, alert email and event selection). None is invented here.
 * Consequently, by default this endpoint is unauthenticated: anyone who knows the URL can
 * submit events. Mitigations in place: POST only, payload validation, idempotency, no
 * echo of submitted data, generic errors, no secrets in logs.
 *
 * OPTIONAL hardening (OUR mechanism, not a CallerDesk feature): set CALLERDESK_WEBHOOK_TOKEN
 * and register the webhook URL as  .../api/webhooks/callerdesk?token=<value>. Requests
 * without the exact token are rejected with 401. A URL-embedded secret can appear in
 * proxy/access logs and the CallerDesk dashboard, so treat it as defence in depth only.
 */

const METHOD_NOT_ALLOWED = 405;

let cachedService: CallerDeskWebhookService | undefined;

function getService(): CallerDeskWebhookService {
  cachedService ??= createCallerDeskWebhookService(createPrismaCallEventStore(prisma), {
    timestampUtcOffset: process.env.CALLERDESK_TIMESTAMP_UTC_OFFSET?.trim() || DEFAULT_TIMESTAMP_UTC_OFFSET,
  });
  return cachedService;
}

function tokensMatch(provided: string, expected: string): boolean {
  // Hash first so lengths are equal and the comparison is constant-time.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Returns true when the request may proceed. */
export function isWebhookAuthorised(req: Request): boolean {
  const expected = process.env.CALLERDESK_WEBHOOK_TOKEN?.trim();
  if (!expected) return true; // token protection not enabled

  const provided = req.query.token;
  return typeof provided === "string" && provided.length > 0 && tokensMatch(provided, expected);
}

/** `getSvc` is injectable so route tests can run without the database. */
export function createCallerDeskWebhookHandler(getSvc: () => CallerDeskWebhookService) {
  return async function handler(req: Request, res: Response): Promise<void> {
    await handleWith(getSvc, req, res);
  };
}

export const handleCallerDeskWebhook = createCallerDeskWebhookHandler(getService);

async function handleWith(getSvc: () => CallerDeskWebhookService, req: Request, res: Response): Promise<void> {
  if (!isWebhookAuthorised(req)) {
    // Never log the supplied token or the query string.
    logger.warn("CallerDesk webhook rejected: category=UNAUTHORISED");
    sendResponse(res, false, null, "Unauthorized", STATUS_CODES.UNAUTHORIZED);
    return;
  }

  let result: Awaited<ReturnType<CallerDeskWebhookService["processWebhook"]>>;
  try {
    result = await getSvc().processWebhook(req.body);
  } catch (err) {
    // processWebhook handles its own failures; this is a last resort so the global
    // error handler (which echoes the error object) is never reached from this route.
    logger.error(`CallerDesk webhook: unexpected error category=${err instanceof Error ? err.name : "UnknownError"}`);
    sendResponse(res, false, null, "Webhook processing failed", STATUS_CODES.SERVER_ERROR);
    return;
  }

  switch (result.outcome) {
    case "INVALID":
      sendResponse(res, false, null, "Invalid webhook payload", STATUS_CODES.BAD_REQUEST);
      return;

    case "FAILED":
      // Non-2xx so CallerDesk can retry / alert; the raw event has been persisted.
      sendResponse(res, false, null, "Webhook processing failed", STATUS_CODES.SERVER_ERROR);
      return;

    case "DUPLICATE":
      sendResponse(res, true, { duplicate: true }, "Duplicate webhook event ignored", STATUS_CODES.OK);
      return;

    default:
      // PROCESSED / UNMATCHED / IGNORED are all accepted; details stay in our logs.
      sendResponse(res, true, { duplicate: false }, "Webhook event received", STATUS_CODES.OK);
  }
}

export function handleCallerDeskMethodNotAllowed(_req: Request, res: Response): void {
  res.set("Allow", "POST");
  sendResponse(res, false, null, "Method not allowed", METHOD_NOT_ALLOWED);
}
