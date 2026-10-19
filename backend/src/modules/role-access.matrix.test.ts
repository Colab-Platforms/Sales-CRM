// Role x feature matrix for the shared features, checked against the REAL routers: the route-level gate each role passes (the middleware between authentication and the handler is run on its own - no handler,
// no database). Record-level scope (own leads / team / assignment) is enforced in the services and covered by the db-tests; this pins WHO may reach each endpoint.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Router } from "express";
import { Role } from "../../generated/prisma/enums.js";

process.env.JWT_SECRET ||= "throwaway-test-secret";
const { default: orders } = await import("./orders/orders.routes.js");
const { default: abandonment } = await import("./abandonment/abandonment.routes.js");
const { default: whatsapp } = await import("./whatsapp/whatsapp.routes.js");

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => void }[] } };

/** true when the role gets past every route-level middleware (everything but the first, requireAuth, and the last, the handler). */
function allowed(router: Router, method: "get" | "post", path: string, role: Role): boolean {
  const layer = (router.stack as Layer[]).find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer?.route, `route ${method.toUpperCase()} ${path} exists`);
  const middlewares = layer.route.stack.slice(1, -1);
  const req = { user: { id: "u", role, username: "t" }, headers: {} };
  for (const mw of middlewares) {
    let passed = false;
    mw.handle(req, {}, (err?: unknown) => { passed = !err; });
    if (!passed) return false;
  }
  return true;
}

const ALL: Role[] = [Role.ADMIN, Role.MANAGER, Role.HR, Role.SALESPERSON, Role.RECRUITER];
const who = (router: Router, method: "get" | "post", path: string) => ALL.filter((r) => allowed(router, method, path, r)).sort();
const set = (...r: Role[]) => [...r].sort();
const ORDER_ROLES = set(Role.ADMIN, Role.MANAGER, Role.SALESPERSON);
// Routes with no role middleware are open to any signed-in role at the gate; the service scope decides what each can see.
const ANY = set(...ALL);

describe("route-level access by role (shared features)", () => {
  it("My Orders: Salesperson only", () => assert.deepEqual(who(orders, "get", "/mine"), set(Role.SALESPERSON)));

  it("general Orders list and detail (and customer order history) are not narrowed by My Orders", () => {
    assert.deepEqual(who(orders, "get", "/"), ANY);
    assert.deepEqual(who(orders, "get", "/:id"), ANY);
  });

  it("Create Order, its WhatsApp payment options and the prefill are available to Admin, Manager and Salesperson (HR/Recruiter have no order work)", () => {
    assert.deepEqual(who(orders, "post", "/"), ORDER_ROLES);
    assert.deepEqual(who(orders, "get", "/whatsapp-payment-options"), ORDER_ROLES);
    // the prefill route is gate-open; the service scope refuses HR/Recruiter (see orders.chat-assignee.db-test)
    assert.deepEqual(who(orders, "get", "/last-address"), ANY);
  });

  it("abandoned leads: the list is open to Admin/Manager/HR/Salesperson; opening one (detail, order prefill) is Admin/Manager/Salesperson - HR distributes, it does not work leads", () => {
    assert.deepEqual(who(abandonment, "get", "/"), set(Role.ADMIN, Role.MANAGER, Role.HR, Role.SALESPERSON));
    assert.deepEqual(who(abandonment, "get", "/:id"), ORDER_ROLES);
    assert.deepEqual(who(abandonment, "get", "/:id/order-prefill"), ORDER_ROLES);
  });

  it("WhatsApp conversation media and history are gate-open to every signed-in role; the service applies the same conversation visibility as reading the message", () => {
    assert.deepEqual(who(whatsapp, "get", "/messages/:id/media"), ANY);
    assert.deepEqual(who(whatsapp, "get", "/messages/:id"), ANY);
  });
});
