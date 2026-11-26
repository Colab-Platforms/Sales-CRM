// The demo API, mounted at /api/demo. It is a self-contained service: it answers from the in-memory demo world only (demo.data.ts / demo.views.ts) and imports no
// database client and no integration, so a demo request cannot reach production data or a real provider even by mistake. The frontend sends every request of a demo
// session here (never to the normal routes); anything this service does not implement is answered "not available in the demo", never forwarded.
import { Router, type NextFunction, type Request, type Response } from "express";
import { DEMO_ROLES, type DemoRole, type DemoUser, type DemoWorld } from "./demo.data.js";
import { DEMO_SESSION_TTL_MS, accessCodeMatches, isDemoEnabled, personaFor, sessionFor, signDemoToken, startSession, verifyDemoToken, type DemoClaims, type DemoSessionState } from "./demo.session.js";
import * as views from "./demo.views.js";

interface DemoRequest extends Request {
  demo?: { claims: DemoClaims; session: DemoSessionState; viewer: views.Viewer };
}

const ok = (res: Response, data: unknown, message = "OK", status = 200) => void res.status(status).json({ success: true, message, data });
const fail = (res: Response, status: number, message: string) => void res.status(status).json({ success: false, message, data: null });

export const userPayload = (u: DemoUser, role: DemoRole) => ({ id: u.id, name: u.name, username: u.username, role, status: "ACTIVE", demo: true as const });

function tokenFor(world: DemoWorld, sid: string, role: DemoRole) {
  const user = personaFor(world, role);
  return { accessToken: signDemoToken({ sub: user.id, sid, role, demo: true }), user: userPayload(user, role), expiresInSeconds: Math.floor(DEMO_SESSION_TTL_MS / 1000) };
}

/** The one place a demo token is accepted. A real login token fails here (different key and audience). */
function requireDemo(req: DemoRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const claims = header?.startsWith("Bearer ") ? verifyDemoToken(header.slice(7)) : null;
  if (!claims) return void fail(res, 401, "Demo session required or expired. Start the demo again.");
  const session = sessionFor(claims);
  const user = session.world.users.find((u) => u.id === claims.sub);
  if (!user) return void fail(res, 401, "Demo session is not valid.");
  req.demo = { claims, session, viewer: { role: claims.role, user } };
  next();
}

const BLOCKED = "This action is disabled in the demo. Nothing was sent, created or changed.";

export function createDemoRouter(env: Record<string, string | undefined> = process.env): Router {
  const router = Router();

  // Entry is off unless explicitly enabled: with it off every demo path is a plain 404, as if the feature did not exist.
  router.use((_req, res, next) => (isDemoEnabled(env) ? next() : fail(res, 404, "Not found")));

  router.get("/status", (_req, res) => ok(res, { enabled: true, accessCodeRequired: Boolean(env.DEMO_ACCESS_CODE), roles: DEMO_ROLES }));

  // Starts a demo session. The access code (when one is configured) comes from the environment, never from source control.
  router.post("/session", (req, res) => {
    if (!accessCodeMatches((req.body as { accessCode?: unknown } | undefined)?.accessCode, env)) return void fail(res, 403, "That access code is not valid.");
    const session = startSession();
    if (!session) return void fail(res, 429, "Too many demo sessions are starting. Please try again in a minute.");
    ok(res, tokenFor(session.world, session.sid, "ADMIN"), "Demo session started");
  });

  router.use(requireDemo);

  // Demo-only role switch: issues a new DEMO token for the same demo session. It changes no real user, role, permission or claim anywhere.
  router.post("/session/role", (req: DemoRequest, res) => {
    const role = (req.body as { role?: unknown } | undefined)?.role;
    if (!DEMO_ROLES.includes(role as DemoRole)) return void fail(res, 400, "Choose Admin, Manager or Telecaller.");
    ok(res, tokenFor(req.demo!.session.world, req.demo!.claims.sid, role as DemoRole), "Role switched (demo only)");
  });
  router.post("/auth/logout", (_req, res) => ok(res, null, "Demo session ended"));

  // Writes are refused unless listed here; the listed ones change only this session's own copy of the demo data.
  router.patch("/lead/leads/:id", (req: DemoRequest, res) => {
    const { session, viewer } = req.demo!;
    const lead = views.findLead(session.world, viewer, String(req.params.id));
    if (!lead) return void fail(res, 404, "Lead not found");
    const body = (req.body ?? {}) as { workingStatus?: string; priority?: string; note?: string };
    if (typeof body.workingStatus === "string" && (views.WORKING_STATUS_SET as Set<string>).has(body.workingStatus)) lead.workingStatus = body.workingStatus as typeof lead.workingStatus;
    if (body.priority === "LOW" || body.priority === "MEDIUM" || body.priority === "HIGH") lead.priority = body.priority;
    lead.updatedAt = Date.now();
    ok(res, views.mapLead(session.world, lead));
  });
  router.patch("/tasks/:id/complete", (req: DemoRequest, res) => {
    const { session, viewer } = req.demo!;
    const visible = new Set(views.leadsFor(session.world, viewer).map((l) => l.id));
    const task = session.world.tasks.find((t) => t.id === req.params.id && visible.has(t.leadId));
    if (!task) return void fail(res, 404, "Task not found");
    task.done = true;
    ok(res, { id: task.id });
  });
  router.use((req, res, next) => (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" ? next() : fail(res, 403, BLOCKED)));

  const w = (req: DemoRequest) => req.demo!.session.world;
  const v = (req: DemoRequest) => req.demo!.viewer;
  const requireRoles = (...roles: DemoRole[]) => (req: DemoRequest, res: Response, next: NextFunction) => (roles.includes(req.demo!.viewer.role) ? next() : fail(res, 403, "Forbidden"));
  const adminOrManager = requireRoles("ADMIN", "MANAGER");

  router.get("/auth/me", (req: DemoRequest, res) => ok(res, userPayload(v(req).user, v(req).role)));
  router.get("/auth/profile", (req: DemoRequest, res) => ok(res, views.profile(w(req), v(req))));
  router.get("/dashboard", (req: DemoRequest, res) => ok(res, views.dashboard(w(req), v(req))));

  // leads
  router.get("/lead/leads", (req: DemoRequest, res) => ok(res, views.listLeads(w(req), v(req), req.query)));
  router.get("/lead/leads/bucket/summary", (req: DemoRequest, res) => ok(res, views.bucketSummary(w(req), v(req))));
  router.get("/lead/leads/:id", (req: DemoRequest, res) => {
    const lead = views.findLead(w(req), v(req), String(req.params.id));
    return lead ? ok(res, views.mapLead(w(req), lead)) : fail(res, 404, "Lead not found");
  });
  router.get("/lead/leads/:id/assignments", (req: DemoRequest, res) => {
    const lead = views.findLead(w(req), v(req), String(req.params.id));
    return lead ? ok(res, views.leadAssignments(w(req), lead)) : fail(res, 404, "Lead not found");
  });
  router.get("/calling/leads/:id/calls", (req: DemoRequest, res) => {
    const lead = views.findLead(w(req), v(req), String(req.params.id));
    return lead ? ok(res, views.leadCalls(w(req), lead.id)) : fail(res, 404, "Lead not found");
  });
  router.get("/customers/:id/timeline", (req: DemoRequest, res) => {
    const lead = views.findLead(w(req), v(req), String(req.params.id));
    return lead ? ok(res, views.leadTimeline(w(req), lead, req.query)) : fail(res, 404, "Lead not found");
  });
  router.get("/abandonments/by-lead/:id", (_req, res) => ok(res, null));
  router.get("/calling/virtual-numbers", (_req, res) => ok(res, []));
  router.get("/calling/call-outcomes", (_req, res) => ok(res, views.callOutcomes()));
  router.get("/tasks/follow-ups", (req: DemoRequest, res) => ok(res, views.followUps(w(req), v(req))));
  router.get("/segments", (_req, res) => ok(res, []));
  router.get("/integrations/sources", (req: DemoRequest, res) => ok(res, views.sourcesList(w(req))));

  // people
  router.get("/admin/managers", requireRoles("ADMIN"), (req: DemoRequest, res) => ok(res, views.peopleLists(w(req), v(req)).managers));
  router.get("/admin/salespersons", requireRoles("ADMIN"), (req: DemoRequest, res) => ok(res, views.peopleLists(w(req), v(req)).salespersons));
  router.get("/admin/admins", requireRoles("ADMIN"), (req: DemoRequest, res) => ok(res, views.peopleLists(w(req), v(req)).admins));
  router.get("/admin/recruiters", requireRoles("ADMIN"), (_req, res) => ok(res, []));
  router.get("/admin/hr", requireRoles("ADMIN"), (_req, res) => ok(res, []));
  router.get("/admin/groups", requireRoles("ADMIN"), (req: DemoRequest, res) => ok(res, views.groupsFor(w(req), v(req))));
  router.get("/manager/groups", adminOrManager, (req: DemoRequest, res) => ok(res, views.groupsFor(w(req), v(req))));
  router.get("/manager/salespersons/mine", adminOrManager, (req: DemoRequest, res) => ok(res, views.peopleLists(w(req), v(req)).mine));

  // analytics (Manager dashboard, Reports)
  router.get("/manager/analytics", adminOrManager, (req: DemoRequest, res) => ok(res, views.analytics(w(req), v(req), req.query)));
  router.get("/manager/analytics/salespersons/:id", adminOrManager, (req: DemoRequest, res) => {
    const id = String(req.params.id);
    return views.teamFor(w(req), v(req)).some((u) => u.id === id) ? ok(res, views.analytics(w(req), v(req), req.query, id)) : fail(res, 404, "Salesperson not found");
  });

  // orders (the fictional order list; literal paths first so they are never read as an id)
  router.get("/orders/live", (req: DemoRequest, res) => ok(res, views.listOrders(w(req), v(req), req.query)));
  router.get("/orders/live/count", adminOrManager, (req: DemoRequest, res) => ok(res, { status: "ready", total: views.filterOrders(w(req), v(req), req.query).length }));
  router.get("/orders/live/tag-options", (_req, res) => ok(res, { tags: [] }));
  router.get("/orders/filter-options", (req: DemoRequest, res) => ok(res, views.orderFilterOptions(w(req), v(req))));
  router.get("/orders/:id/status-history", (req: DemoRequest, res) => {
    const h = views.orderStatusHistory(w(req), v(req), String(req.params.id));
    return h ? ok(res, h) : fail(res, 404, "Order not found");
  });
  router.get("/orders/:id", (req: DemoRequest, res) => {
    const o = views.orderDetail(w(req), v(req), String(req.params.id));
    return o ? ok(res, o) : fail(res, 404, "Order not found");
  });

  // order-page side panels: nothing to show in the demo (no payments, messages or audit trail are connected)
  const emptyPage = { items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 } };
  router.get("/whatsapp/messages", (_req, res) => ok(res, emptyPage));
  router.get("/orders/:id/audit", (_req, res) => ok(res, emptyPage));
  router.get("/integrations/status", (_req, res) => ok(res, { cashfree: { enabled: false, configured: false, environment: null, webhookRegistered: false }, shiprocket: { enabled: false, configured: false } }));
  router.get("/orders/:id/prepaid-upgrade", (req: DemoRequest, res) => ok(res, { orderId: String(req.params.id), eligible: false, shopifyReconciliation: "NOT_APPLICABLE", isCod: false, reason: "Not available in the demo.", orderAmount: "0.00", currency: "INR", offer: null, history: [] }));

  // products & marketing
  router.get("/products", (req: DemoRequest, res) => ok(res, views.listProducts(w(req), req.query)));
  router.get("/offers/active", (req: DemoRequest, res) => ok(res, views.activeOffers(w(req))));

  // abandoned-checkout summary cards on the dashboards
  router.get("/abandonments/my-summary", (req: DemoRequest, res) => ok(res, views.abandonmentSummaries(w(req), v(req)).mySummary));
  router.get("/abandonments/distribution", adminOrManager, (req: DemoRequest, res) => ok(res, views.abandonmentSummaries(w(req), v(req)).distribution(String(req.query.range ?? "today"))));

  // Anything else: not implemented here, and never forwarded anywhere.
  router.use((_req, res) => fail(res, 404, "This screen or feature is not available in the demo."));
  return router;
}

export default createDemoRouter();
