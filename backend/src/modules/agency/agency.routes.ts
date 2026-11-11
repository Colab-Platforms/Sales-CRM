// POST /api/agency/whatsapp/payment-link - for the external AI calling agency only. Authenticated by API key (not by a CRM user session), JSON in, JSON out. Mounted in routes.ts.
import { Router, type NextFunction, type Request, type Response } from "express";
import { logger } from "@/utils/logger.js";
import { extractApiKey, hashApiKey } from "./agency.keys.js";
import { SlidingWindowLimiter } from "./agency.ratelimit.js";
import { AgencyPaymentLinkService, DEFAULT_OPTIONS, type AgencyKeyRow, type AgencyMessaging, type AgencyOptions, type AgencyRepo, type PaymentLinkMaker } from "./agency.payment-link.service.js";
import { CashfreeLinkMaker } from "./agency.cashfree-links.js";
import { PrismaAgencyRepo } from "./agency.repo.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";

export interface AgencyRouteDeps {
  repo: AgencyRepo;
  messaging: AgencyMessaging;
  /** Creates the payment link of an order: the CRM's own Cashfree payment-link service in production. */
  links: PaymentLinkMaker;
  options?: Partial<AgencyOptions>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/** The caller's address. Behind Render's proxy req.ip is the proxy, so the entry the nearest proxy appended (the last one in X-Forwarded-For) is used; it cannot be forged by the caller. */
export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "").split(",").map((p) => p.trim()).filter(Boolean).pop();
  return (last || req.ip || "unknown").slice(0, 64);
}

const envNumber = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/** The router, with its collaborators injected so tests run it without a database or Meta. The real wiring is `agencyRoutes` below. */
export function createAgencyRouter(deps: AgencyRouteDeps): Router {
  const env = deps.env ?? process.env;
  const options: AgencyOptions = {
    ...DEFAULT_OPTIONS,
    perRecipientPerHour: envNumber(env.AGENCY_RECIPIENT_LIMIT_PER_HOUR, DEFAULT_OPTIONS.perRecipientPerHour),
    requireExplicitOptIn: env.AGENCY_REQUIRE_EXPLICIT_OPT_IN === "true",
    preferredTemplate: env.AGENCY_PAYMENT_LINK_TEMPLATE?.trim() || null,
    ...deps.options,
  };
  const service = new AgencyPaymentLinkService(deps.repo, deps.messaging, deps.links, options, deps.now);
  const perKey = new SlidingWindowLimiter(60_000);
  const badAuth = new SlidingWindowLimiter(60_000);
  const ceiling = envNumber(env.AGENCY_RATE_LIMIT_PER_MINUTE, 0);
  const router = Router();

  const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({ success: false, requestId: res.locals.requestId, error: { code, message, ...extra } });
  };

  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = clientIp(req);
      const key = extractApiKey(req.headers);
      const row = key ? await deps.repo.findKeyByHash(hashApiKey(key)) : null;
      if (!row || !row.isActive || row.revokedAt) {
        const limited = !badAuth.take(`bad:${ip}`, 20).allowed;
        if (limited) {
          res.setHeader("Retry-After", "60");
          return fail(res, 429, "TOO_MANY_FAILED_ATTEMPTS", "Too many requests with an invalid API key. Try again in a minute.");
        }
        logger.warn(`[agency] 401 invalid or missing API key from ${ip} requestId=${res.locals.requestId}`);
        return fail(res, 401, "UNAUTHORIZED", "A valid API key is required. Send it in the X-API-Key header.");
      }
      res.locals.agencyKey = row satisfies AgencyKeyRow;
      void deps.repo.touchKey(row.id, (deps.now ?? (() => new Date()))()).catch(() => {});
      next();
    } catch (error) {
      logger.error("[agency] authentication failed unexpectedly", error instanceof Error ? error.message : error);
      fail(res, 500, "INTERNAL_ERROR", "The request could not be authenticated right now. Try again shortly.");
    }
  };

  router.post("/whatsapp/payment-link", authenticate, async (req, res) => {
    const key = res.locals.agencyKey as AgencyKeyRow;
    const limit = ceiling > 0 ? Math.min(key.rateLimitPerMinute, ceiling) : key.rateLimitPerMinute;
    const taken = perKey.take(`key:${key.id}`, limit);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(taken.remaining));
    if (!taken.allowed) {
      res.setHeader("Retry-After", String(taken.retryAfterSeconds));
      return fail(res, 429, "RATE_LIMITED", `Rate limit of ${limit} requests per minute exceeded. Retry after ${taken.retryAfterSeconds} seconds.`, { retryable: true });
    }
    try {
      const out = await service.handle({ key, body: req.body, idempotencyKeyHeader: req.header("idempotency-key"), sourceIp: clientIp(req) });
      res.setHeader("Cache-Control", "no-store");
      if (out.retryAfterSeconds) res.setHeader("Retry-After", String(out.retryAfterSeconds));
      // The request id the service minted is the one the agency quotes; the header carries the same value.
      const body = out.body as { requestId?: string };
      if (body.requestId) res.setHeader("X-Request-Id", body.requestId);
      res.status(out.httpStatus).json(out.body);
    } catch (error) {
      logger.error("[agency] unexpected error", error instanceof Error ? error.message : error);
      fail(res, 500, "INTERNAL_ERROR", "The CRM could not process this request. Nothing was confirmed as sent; retry with the same Idempotency-Key.", { retryable: true });
    }
  });

  return router;
}

// Malformed JSON on this route is answered in the same shape as every other error here (the app-wide handler would answer in the CRM's own format).
export function agencyJsonErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: string; status?: number };
  if (e?.type === "entity.parse.failed" || e?.type === "entity.too.large") {
    res.status(e.status ?? 400).json({ success: false, requestId: res.locals.requestId, error: { code: e.type === "entity.too.large" ? "BODY_TOO_LARGE" : "INVALID_JSON", message: e.type === "entity.too.large" ? "The request body is too large" : "The request body is not valid JSON" } });
    return;
  }
  next(err);
}

/** The real thing: Prisma storage and the existing WhatsApp messaging service (Meta credentials come from Settings -> WhatsApp Config, never from here). */
export function createAgencyRoutes(): Router {
  return createAgencyRouter({ repo: new PrismaAgencyRepo(), messaging: new WhatsAppMessagingService(), links: new CashfreeLinkMaker() });
}
