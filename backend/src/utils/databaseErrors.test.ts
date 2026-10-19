import test from "node:test";
import assert from "node:assert/strict";
import { classifyDatabaseError, DATABASE_UNAVAILABLE_MESSAGE, respondIfDatabaseUnavailable } from "./databaseErrors.js";
import { errorHandler } from "../middlewares/errorHandler.js";

// The exact shape of the failure seen in production: Prisma wrapping Neon's 53000 quota error. Contains source paths and the query text a user must never see.
const neonQuota = () =>
  Object.assign(new Error("Invalid `this.db.order.findFirst()` invocation in /app/src/modules/orders/orders.live.service.ts:485:42\n\nYour account or project has exceeded the quota. Upgrade your plan to increase limits."), {
    code: "53000",
  });

const mockRes = () => {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as any };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res);
  return res;
};

test("classifies Neon's quota error (SQLSTATE 53000 and message-only) as a 503 quota failure", () => {
  assert.equal(classifyDatabaseError(neonQuota())?.kind, "quota");
  assert.equal(classifyDatabaseError(new Error("Your account or project has exceeded the quota."))?.kind, "quota");
  assert.equal(classifyDatabaseError({ message: "x", meta: { driverAdapterError: { cause: { originalCode: "53000" } } } })?.kind, "quota");
});

test("classifies unreachable / closed / out-of-connections as unavailable and pool / transaction timeouts as timeout", () => {
  for (const code of ["P1001", "P1002", "P1017", "53300"]) assert.equal(classifyDatabaseError({ code, message: "m" })?.kind, "unavailable", code);
  for (const code of ["P1008", "P2024", "P2028"]) assert.equal(classifyDatabaseError({ code, message: "m" })?.kind, "timeout", code);
  assert.equal(classifyDatabaseError(new Error("Can't reach database server at host"))?.kind, "unavailable");
  assert.equal(classifyDatabaseError(new Error("Transaction API error: expired transaction"))?.kind, "timeout");
});

test("does not classify ordinary application or constraint errors", () => {
  assert.equal(classifyDatabaseError(Object.assign(new Error("Unique constraint failed"), { code: "P2002" })), null);
  assert.equal(classifyDatabaseError(Object.assign(new Error("Not found"), { statusCode: 404 })), null);
  assert.equal(classifyDatabaseError(new Error("boom")), null);
  assert.equal(classifyDatabaseError(null), null);
  assert.equal(classifyDatabaseError("string"), null);
});

test("respondIfDatabaseUnavailable sends a safe 503 and leaks neither the Prisma text nor the error object", () => {
  const res = mockRes();
  assert.equal(respondIfDatabaseUnavailable(res, neonQuota()), true);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Retry-After"], "300");
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, DATABASE_UNAVAILABLE_MESSAGE);
  assert.equal(res.body.data, null);
  const raw = JSON.stringify(res.body);
  for (const leak of ["findFirst", "orders.live.service", "53000", "quota", "Prisma"]) assert.ok(!raw.includes(leak), `leaked: ${leak}`);
});

test("respondIfDatabaseUnavailable leaves other errors alone (the caller keeps its own status and message)", () => {
  const res = mockRes();
  assert.equal(respondIfDatabaseUnavailable(res, Object.assign(new Error("Order not found"), { statusCode: 404 })), false);
  assert.equal(res.body, undefined);
});

test("global errorHandler: a quota error becomes the safe 503; any other error is unchanged", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const quota = mockRes();
    errorHandler(neonQuota(), {} as any, quota, () => {});
    assert.equal(quota.statusCode, 503);
    assert.equal(quota.body.message, DATABASE_UNAVAILABLE_MESSAGE);
    assert.equal(quota.body.data, null);
    assert.equal(quota.headers["Retry-After"], "300");

    const other = mockRes();
    errorHandler(Object.assign(new Error("Forbidden thing"), { statusCode: 403 }), {} as any, other, () => {});
    assert.equal(other.statusCode, 403);
    assert.equal(other.body.message, "Forbidden thing");
  } finally {
    console.error = original;
  }
});
