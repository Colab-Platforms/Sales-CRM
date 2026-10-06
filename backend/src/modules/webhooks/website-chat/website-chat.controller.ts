import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { createWebsiteChatWebhookService, type WebsiteChatWebhookService } from "./website-chat.service.js";
import { createPrismaWebChatEventStore } from "./website-chat.store.js";

/**
 * SECURITY
 *
 * Unlike CallerDesk (which CallerDesk's own docs confirm has no signature/secret mechanism at
 * all), the chatbot is our own application - a dedicated shared secret is mandatory here, not
 * optional. `WEBSITE_CHAT_WEBHOOK_SECRET` must be set, sent as the `x-webhook-secret` header. This
 * is a completely separate secret from CRM JWTs (never accepted here) and from whatever secret
 * Phase 2 uses for the reverse direction (CRM -> chatbot) - never logged, never echoed.
 */

let cachedService: WebsiteChatWebhookService | undefined;

function getService(): WebsiteChatWebhookService {
  cachedService ??= createWebsiteChatWebhookService(createPrismaWebChatEventStore(prisma));
  return cachedService;
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Returns true when the request carries the exact configured secret. Fails closed: an unset
 * WEBSITE_CHAT_WEBHOOK_SECRET authorises nothing (the opposite of CallerDesk's optional token). */
export function isWebsiteChatWebhookAuthorised(req: Request): boolean {
  const expected = process.env.WEBSITE_CHAT_WEBHOOK_SECRET?.trim();
  if (!expected) return false;

  const provided = req.headers["x-webhook-secret"];
  return typeof provided === "string" && provided.length > 0 && secretsMatch(provided, expected);
}

export function createWebsiteChatWebhookHandler(getSvc: () => WebsiteChatWebhookService) {
  return async function handler(req: Request, res: Response): Promise<void> {
    if (!isWebsiteChatWebhookAuthorised(req)) {
      // Never log the supplied secret or the header itself.
      logger.warn("Website Chat webhook rejected: category=UNAUTHORISED");
      sendResponse(res, false, null, "Unauthorized", STATUS_CODES.UNAUTHORIZED);
      return;
    }

    let result: Awaited<ReturnType<WebsiteChatWebhookService["processWebhook"]>>;
    try {
      result = await getSvc().processWebhook(req.body);
    } catch (err) {
      logger.error(`Website Chat webhook: unexpected error category=${err instanceof Error ? err.name : "UnknownError"}`);
      sendResponse(res, false, null, "Webhook processing failed", STATUS_CODES.SERVER_ERROR);
      return;
    }

    switch (result.outcome) {
      case "INVALID":
        sendResponse(res, false, null, "Invalid webhook payload", STATUS_CODES.BAD_REQUEST);
        return;
      case "DUPLICATE":
        sendResponse(res, true, { duplicate: true }, "Duplicate webhook event ignored", STATUS_CODES.OK);
        return;
      default:
        sendResponse(res, true, { duplicate: false, handoffAccepted: result.handoffAccepted }, "Webhook event received", STATUS_CODES.OK);
    }
  };
}

export const handleWebsiteChatWebhook = createWebsiteChatWebhookHandler(getService);

export function handleWebsiteChatMethodNotAllowed(_req: Request, res: Response): void {
  res.set("Allow", "POST");
  sendResponse(res, false, null, "Method not allowed", 405);
}
