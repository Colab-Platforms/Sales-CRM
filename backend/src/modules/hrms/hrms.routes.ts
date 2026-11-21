import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { logger } from "@/utils/logger.js";
import { createHrmsGuard, HrmsHttpError, type HrmsGuardOptions } from "./hrms.auth.js";
import { HRMS_TIMEZONE, resolveHrmsRange, type HrmsRange } from "./hrms.range.js";
import { HrmsReportingService, type HrmsDeps, type Rec, type Report } from "./hrms.service.js";

// ROUTES of the HRMS reporting API, mounted at /api/hrms/v1 BEFORE the CRM's JSON parser (the API reads no body). The guard runs first for every request, so nothing below it is reachable without the key.
// Responses are an envelope { success, range: {from,to,timezone,kind,days}, generatedAt, data, availability, basis, notes }. When EVERY section of an endpoint failed the answer is 503, never a 200 full of nulls.

export interface HrmsRouterOptions {
  guard?: HrmsGuardOptions;
  service?: HrmsReportingService;
  deps?: HrmsDeps;
  now?: () => Date;
}

type Handler = (range: HrmsRange) => Promise<Report<Rec>>;

export function createHrmsRouter(options: HrmsRouterOptions = {}): Router {
  const now = options.now ?? (() => new Date());
  const service = options.service ?? new HrmsReportingService({ now, ...options.deps });
  const router = Router();
  router.use(createHrmsGuard(options.guard));

  router.get("/health", async (_req, res, next) => {
    try {
      const h = await service.health();
      res.status(h.ok ? 200 : 503).json({ success: h.ok, ...h });
    } catch (e) {
      next(e);
    }
  });

  const report = (path: string, run: Handler) =>
    router.get(path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const earliest = String(req.query.range ?? "").trim().toLowerCase() === "all_time" ? await service.earliestDay() : null;
        const range = resolveHrmsRange({ range: req.query.range, from: req.query.from, to: req.query.to }, now(), earliest);
        const r = await run(range);
        const states = Object.values(r.availability);
        if (states.length > 0 && states.every((s) => !s.available)) {
          res.status(503).json({ success: false, error: { code: "INTERNAL_ERROR", message: "None of the sections of this report could be calculated right now." }, availability: r.availability });
          return;
        }
        res.json({
          success: true,
          range: { kind: range.kind, from: range.from, to: range.to, days: range.days, timezone: HRMS_TIMEZONE },
          from: range.from,
          to: range.to,
          timezone: HRMS_TIMEZONE,
          generatedAt: now().toISOString(),
          ...r,
        });
      } catch (e) {
        next(e);
      }
    });

  report("/sales", (r) => service.sales(r));
  report("/orders", (r) => service.orders(r));
  report("/leads", (r) => service.leads(r));
  report("/telecallers", (r) => service.telecallers(r));
  report("/employees", (r) => service.employees(r));
  report("/products", (r) => service.products(r));
  report("/payments", (r) => service.payments(r));
  report("/marketing", (r) => service.marketing(r));

  router.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Unknown HRMS endpoint." } });
  });

  // Own error handler: logs method, path, status and the error KIND only - never the query string, headers or the error message (which may quote data).
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HrmsHttpError) {
      res.status(err.status).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    const id = randomUUID().slice(0, 8);
    logger.error(`HRMS API error ${req.method} ${req.baseUrl}${req.path} ref=${id} kind=${err instanceof Error ? err.name : "unknown"}`);
    res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: `Internal error (ref ${id}).` } });
  });

  return router;
}
