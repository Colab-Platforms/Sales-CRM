// Who may run "Sync order to CRM": the route's role gate and the service's own check, both from LIVE_ORDER_SYNC_ROLES. No Shopify, no database - the sync itself is a fake.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Response } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import OrdersLiveService from "./orders.live.service.js";
import { LIVE_ORDER_SYNC_ROLES, canViewAllOrders } from "./orders.filters.js";
import { ApiError } from "@/utils/apiError.js";

process.env.JWT_SECRET ||= "throwaway-test-secret"; // the auth module refuses to load without one
const { requireAuth, requireRole } = await import("@/middlewares/auth.js");

const user = (role: Role) => ({ id: "u1", role, username: "x" }) as never;
function service(sync: (...a: unknown[]) => Promise<unknown>) {
  return new OrdersLiveService({} as never, () => ({}) as never, {} as never, sync as never, () => undefined as never);
}
const gate = (u: { role: Role } | undefined) => {
  let err: unknown = null;
  requireRole(...LIVE_ORDER_SYNC_ROLES)({ user: u } as unknown as AuthRequest, {} as Response, ((e?: unknown) => { err = e ?? null; }) as NextFunction);
  return err;
};

describe("sync order to CRM: roles", () => {
  it("the list is exactly Admin, Manager, Telecaller (SALESPERSON) and HR", () => {
    assert.deepEqual([...LIVE_ORDER_SYNC_ROLES].sort(), [Role.ADMIN, Role.HR, Role.MANAGER, Role.SALESPERSON].sort());
  });
  it("route gate: the four roles pass; Recruiter and a missing user are Forbidden", () => {
    for (const r of LIVE_ORDER_SYNC_ROLES) assert.equal(gate({ role: r }), null, r);
    assert.ok(gate({ role: Role.RECRUITER }) instanceof ApiError);
    assert.ok(gate(undefined) instanceof ApiError);
  });
  it("an unauthenticated request is rejected by requireAuth before the role gate", () => {
    let err: unknown = null;
    requireAuth({ headers: {}, cookies: {} } as unknown as AuthRequest, {} as Response, ((e?: unknown) => { err = e ?? null; }) as NextFunction);
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).statusCode, 401);
  });
  it("granting the sync grants no read access: HR still cannot read orders", () => {
    assert.equal(canViewAllOrders(Role.HR), false);
    assert.deepEqual([Role.ADMIN, Role.MANAGER, Role.SALESPERSON].map(canViewAllOrders), [true, true, true]);
  });
});

describe("OrdersLiveService.syncLiveOrderToCrm", () => {
  it("every allowed role reaches the (idempotent) sync for exactly the one order id; repeating returns the same CRM order", async () => {
    for (const role of LIVE_ORDER_SYNC_ROLES) {
      const calls: string[] = [];
      let n = 0;
      const svc = service(async (_deps: unknown, gid: unknown) => { calls.push(String(gid)); return { result: { orderId: "crm-1", action: n++ === 0 ? "created" : "updated" } }; });
      const a = await svc.syncLiveOrderToCrm(user(role), "6571234567890");
      const b = await svc.syncLiveOrderToCrm(user(role), "6571234567890");
      assert.deepEqual([a.synced, a.orderId, a.action, b.synced, b.orderId, b.action], [true, "crm-1", "created", true, "crm-1", "updated"], role);
      assert.deepEqual(calls, ["gid://shopify/Order/6571234567890", "gid://shopify/Order/6571234567890"], role);
    }
  });
  it("a role outside the list is refused as 'Not found' without calling the sync", async () => {
    let called = false;
    const svc = service(async () => { called = true; return {}; });
    const r = await svc.syncLiveOrderToCrm(user(Role.RECRUITER), "123");
    assert.deepEqual([r.synced, r.reason, called], [false, "Not found", false]);
  });
  it("a sync failure is reported with a clear message and writes nothing further", async () => {
    const svc = service(async () => { throw new Error("db exploded"); });
    const r = await svc.syncLiveOrderToCrm(user(Role.SALESPERSON), "123");
    assert.equal(r.synced, false);
    assert.match(r.reason ?? "", /nothing was changed/);
    const gone = await service(async () => ({ notFound: true })).syncLiveOrderToCrm(user(Role.HR), "123");
    assert.deepEqual([gone.synced, gone.reason], [false, "Shopify no longer has this order."]);
  });
});
