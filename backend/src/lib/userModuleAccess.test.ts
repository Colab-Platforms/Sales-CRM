import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";

// jwt.ts reads the secret when it is first imported, so it is set before the modules below are loaded.
process.env.JWT_SECRET ||= "test-secret-for-module-access";
const { signToken } = await import("./jwt.js");
const { MODULE_KEYS, blockedModulesFor, moduleAccessGuard, moduleOfRequest } = await import("./userModuleAccess.js");

const ADITYA = { username: "aditya_awl", role: "MANAGER" };

test("only Aditya's manager login is restricted - not other managers, admins or anyone else", () => {
  assert.deepEqual(blockedModulesFor(ADITYA), [...MODULE_KEYS]);
  assert.deepEqual(blockedModulesFor({ username: "ADITYA_AWL ", role: "MANAGER" }), [...MODULE_KEYS]); // case / whitespace do not matter
  assert.deepEqual(blockedModulesFor({ username: "meera", role: "MANAGER" }), []);
  assert.deepEqual(blockedModulesFor({ username: "aditya_awl", role: "ADMIN" }), []); // promoted / admin: never restricted
  assert.deepEqual(blockedModulesFor({ username: "aditya_awl", role: "SALESPERSON" }), []);
});

test("each module's own endpoints are recognised", () => {
  const cases: [string, string, string][] = [
    ["GET", "/offers/active", "offers"],
    ["PUT", "/products/abc/weight", "product-weights"],
    ["PUT", "/products/variants/abc/weight", "product-weights"],
    ["POST", "/products/catalog-import", "product-weights"],
    ["GET", "/products/catalog-import/j1/failed-rows", "product-weights"],
    ["GET", "/orders/reconciliation", "reconciliation"],
    ["GET", "/shipments", "shiprocket"],
    ["GET", "/shipments/filter-options", "shiprocket"],
    ["GET", "/shipments/123", "shiprocket"],
    ["GET", "/performance-matrix", "performance-matrix"],
    ["GET", "/report-automation/config", "report-automation"],
    ["POST", "/report-automation/test-send", "report-automation"],
    ["GET", "/audit", "audit-trail"],
    ["GET", "/audit/", "audit-trail"],
  ];
  for (const [method, path, module] of cases) assert.equal(moduleOfRequest(method, path), module, `${method} ${path}`);
});

test("endpoints that screens Aditya keeps depend on stay open", () => {
  const open: [string, string][] = [
    ["GET", "/products"], // WhatsApp create-order product list
    ["GET", "/shipments/123/couriers"], // order detail shipment actions
    ["POST", "/shipments/123/assign-awb"],
    ["POST", "/shipments/123/label"],
    ["POST", "/orders/o1/shipments"],
    ["GET", "/orders/o1/audit"], // a single order's / customer's own history
    ["GET", "/customers/l1/audit"],
    ["GET", "/orders"],
    ["GET", "/orders/o1"],
    ["GET", "/abandonments/call-recordings"],
    ["GET", "/manager/dashboard"],
    ["GET", "/refund-requests"],
    ["GET", "/tickets"],
    ["GET", "/whatsapp/conversations"],
  ];
  for (const [method, path] of open) assert.equal(moduleOfRequest(method, path), null, `${method} ${path}`);
});

function run(token: string | null, method: string, path: string): { status: number | null } {
  let status: number | null = null;
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, method, path } as unknown as Request;
  moduleAccessGuard(req, {} as never, (err?: unknown) => {
    status = err ? ((err as { statusCode?: number }).statusCode ?? 500) : null;
  });
  return { status };
}

test("the API guard refuses Aditya on his blocked modules and nothing else", () => {
  const aditya = signToken({ sub: "u1", role: "MANAGER" as never, username: "aditya_awl" });
  for (const [m, p] of [["GET", "/offers/active"], ["GET", "/audit"], ["GET", "/performance-matrix"], ["GET", "/orders/reconciliation"], ["GET", "/shipments"], ["GET", "/report-automation/config"], ["PUT", "/products/x/weight"]] as const) {
    assert.equal(run(aditya, m, p).status, 403, `${m} ${p}`);
  }
  for (const [m, p] of [["GET", "/products"], ["GET", "/orders"], ["GET", "/shipments/1/couriers"], ["GET", "/abandonments/call-recordings"], ["GET", "/orders/o1/audit"]] as const) {
    assert.equal(run(aditya, m, p).status, null, `${m} ${p}`);
  }
});

test("other managers, admins and unauthenticated calls pass through untouched", () => {
  const other = signToken({ sub: "u2", role: "MANAGER" as never, username: "meera_manager" });
  const admin = signToken({ sub: "u3", role: "ADMIN" as never, username: "aditya_awl" });
  for (const token of [other, admin]) {
    for (const p of ["/offers/active", "/audit", "/performance-matrix", "/orders/reconciliation", "/shipments", "/report-automation/config"]) assert.equal(run(token, "GET", p).status, null, p);
  }
  assert.equal(run(null, "GET", "/audit").status, null); // no token: the route's own auth answers 401
  assert.equal(run("not-a-token", "GET", "/audit").status, null);
});
