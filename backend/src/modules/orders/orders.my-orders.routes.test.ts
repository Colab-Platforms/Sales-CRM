// HTTP-level role check of the real orders router: who may call GET /orders/mine. Denied roles are refused BEFORE any handler or database is reached.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { Role } from "../../../generated/prisma/enums.js";

// A throwaway secret for signing test tokens (set before the modules that read it are loaded).
process.env.JWT_SECRET ||= "throwaway-test-secret";
const { signToken } = await import("../../lib/jwt.js");
const { default: router, MY_ORDERS_ROLES } = await import("./orders.routes.js");
const { default: OrdersService } = await import("./orders.service.js");

async function call(path: string, role?: Role): Promise<number> {
  const app = express();
  app.use("/orders", router);
  app.use((err: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.statusCode ?? 500).json({ ok: false }); });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = role ? { Authorization: `Bearer ${signToken({ sub: "00000000-0000-4000-8000-000000000001", role, username: "t" } as never)}` } : {};
    return (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status;
  } finally {
    server.close();
  }
}

describe("GET /orders/mine - Salesperson only", () => {
  it("the allowed role set is exactly the Salesperson", () => assert.deepEqual(MY_ORDERS_ROLES, [Role.SALESPERSON]));
  it("no token -> 401; Admin, Manager, HR and Recruiter -> 403 (direct API access is blocked, not just hidden)", async () => {
    assert.equal(await call("/orders/mine"), 401);
    for (const role of [Role.ADMIN, Role.MANAGER, Role.HR, Role.RECRUITER]) assert.equal(await call("/orders/mine", role), 403, role);
  });
});

describe("OrdersService.listMyOrders - the service refuses non-Salespersons before touching any data", () => {
  it("Admin, Manager, HR and Recruiter get 403 (a database that is never reached)", async () => {
    const svc = new OrdersService({} as never);
    for (const role of [Role.ADMIN, Role.MANAGER, Role.HR, Role.RECRUITER]) {
      await assert.rejects(() => svc.listMyOrders({ id: "u", username: "t", role }, { page: 1, pageSize: 10 } as never), (e: { statusCode?: number }) => e.statusCode === 403, role);
    }
  });
});
