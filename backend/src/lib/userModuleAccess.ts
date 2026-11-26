// Loaded first on purpose: jwt.ts reads JWT_SECRET the moment it is imported, and this file is imported (by routes.ts) before anything else has loaded .env.
import "dotenv/config";
import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "@/lib/jwt.js";
import { Role } from "../../generated/prisma/enums.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

// Per-user module access: a short, named list of modules a SPECIFIC user may not use, on top of the normal role rules. Nothing here deletes a module or any data - the modules, their
// routes and their records all stay exactly as they are; this only decides, for the signed-in user, whether the sidebar shows a module and whether its API answers.
//
// One policy, two consumers: the sign-in payload (so the app hides the sidebar entry and refuses the URL) and the API guard below (so the server refuses it even if someone calls the
// endpoint directly). Restrictions apply only to the listed username AND only while that account is a MANAGER: an admin, a super admin or any other manager is never affected.

export const MODULE_KEYS = ["offers", "product-weights", "reconciliation", "shiprocket", "performance-matrix", "report-automation", "audit-trail"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** username (lower case) -> modules that user may not use. Add a user here to restrict them; remove the line to give everything back. */
const RESTRICTED_MANAGERS: Record<string, readonly ModuleKey[]> = {
  aditya_awl: ["offers", "product-weights", "reconciliation", "shiprocket", "performance-matrix", "report-automation", "audit-trail"],
};

export function blockedModulesFor(user: { username: string; role: string }): ModuleKey[] {
  if (user.role !== Role.MANAGER) return [];
  return [...(RESTRICTED_MANAGERS[user.username.trim().toLowerCase()] ?? [])];
}

interface ApiRule {
  /** Empty = every method. */
  methods?: readonly string[];
  /** Matched against the path under /api, without a trailing slash. */
  path: RegExp;
}

/**
 * The API surface of each module - ONLY what that module's own page uses. Endpoints another, still-allowed screen shares are deliberately left open:
 *  - GET /products feeds the WhatsApp create-order dialog (only the weight editing and catalogue import of Product Weights are blocked);
 *  - the shipment actions (couriers, AWB, pickup, label, tracking) are used from the order detail page (only the Shiprocket list / detail reads are blocked);
 *  - a single order's or customer's own audit history (/orders/:id/audit, /customers/:id/audit) is part of those pages (only the global Audit Trail is blocked).
 */
const MODULE_API: Record<ModuleKey, readonly ApiRule[]> = {
  offers: [{ path: /^\/offers(\/|$)/ }],
  "product-weights": [
    { methods: ["PUT"], path: /^\/products\/(variants\/)?[^/]+\/weight$/ },
    { path: /^\/products\/catalog-import(\/|$)/ },
  ],
  reconciliation: [{ methods: ["GET"], path: /^\/orders\/reconciliation$/ }],
  shiprocket: [{ methods: ["GET"], path: /^\/shipments(\/filter-options|\/[^/]+)?$/ }],
  "performance-matrix": [{ path: /^\/performance-matrix(\/|$)/ }],
  // The scheduled-run trigger (/report-automation/cron) is called by the scheduler with its own secret, never by a manager's token, so it is unaffected.
  "report-automation": [{ path: /^\/report-automation(\/|$)/ }],
  "audit-trail": [{ path: /^\/audit(\/|$)/ }],
};

/** Which restricted module (if any) a request belongs to. Pure, for the guard and for tests. */
export function moduleOfRequest(method: string, path: string): ModuleKey | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const key of MODULE_KEYS) {
    for (const rule of MODULE_API[key]) {
      if ((!rule.methods || rule.methods.includes(method.toUpperCase())) && rule.path.test(clean)) return key;
    }
  }
  return null;
}

/**
 * Mounted once, ahead of the module routers. It reads the bearer token only to learn WHO is calling (a missing or bad token is left for the route's own auth to refuse with the usual 401),
 * and answers 403 when that user is restricted from the module the request belongs to. A user with no restrictions pays one object lookup.
 */
export function moduleAccessGuard(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  let blocked: ModuleKey[];
  try {
    const payload = verifyToken(header.slice(7));
    blocked = blockedModulesFor({ username: payload.username, role: payload.role });
  } catch {
    return next();
  }
  if (blocked.length === 0) return next();
  const module = moduleOfRequest(req.method, req.path);
  if (module && blocked.includes(module)) return next(new ApiError("You do not have access to this module.", STATUS_CODES.FORBIDDEN));
  next();
}
