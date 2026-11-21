/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";
import { logger } from "@/utils/logger.js";
import { clientAddress, keysMatch, readIntegrationKey } from "./hrms.auth.js";
import { createHrmsRouter } from "./hrms.routes.js";
import { HrmsReportingService } from "./hrms.service.js";

const KEY = "test-key-0123456789-abcdef";
const NOW = new Date("2026-11-21T08:00:00Z");

const okReport = async () => ({ data: { x: 1 }, availability: { x: { available: true, error: null } }, basis: {} });
const stub = {
  health: async () => ({ ok: true, service: "hrms-reporting", apiVersion: "v1", timezone: "Asia/Kolkata", database: true, today: "2026-11-21", generatedAt: NOW.toISOString() }),
  earliestDay: async () => "2026-01-05",
  sales: okReport,
  orders: okReport,
  leads: okReport,
  telecallers: okReport,
  employees: okReport,
  products: okReport,
  payments: okReport,
  marketing: okReport,
} as unknown as HrmsReportingService;

async function serve(env: Record<string, string | undefined>, extra: { perMinute?: number; failedPerMinute?: number; service?: HrmsReportingService } = {}) {
  const app = express();
  app.use("/api/hrms/v1", createHrmsRouter({ guard: { env, trustedProxyHops: 0, ...extra }, service: extra.service ?? stub, now: () => NOW }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const port = (server.address() as { port: number }).port;
  return { server, url: (p: string) => `http://127.0.0.1:${port}/api/hrms/v1${p}` };
}

describe("key handling", () => {
  test("readIntegrationKey: unset, blank and short keys are 'not configured'", () => {
    assert.equal(readIntegrationKey({}), null);
    assert.equal(readIntegrationKey({ HRMS_INTEGRATION_API_KEY: "   " }), null);
    assert.equal(readIntegrationKey({ HRMS_INTEGRATION_API_KEY: "short" }), null);
    assert.equal(readIntegrationKey({ HRMS_INTEGRATION_API_KEY: `"${KEY}"` }), KEY);
  });
  test("keysMatch compares exactly, whatever the lengths", () => {
    assert.equal(keysMatch(KEY, KEY), true);
    assert.equal(keysMatch(KEY + "x", KEY), false);
    assert.equal(keysMatch("", KEY), false);
  });
  test("clientAddress trusts only the entry the nearest proxy appended", () => {
    const req = (xff: string) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.1" } }) as never;
    assert.equal(clientAddress(req("1.1.1.1, 2.2.2.2"), 1), "2.2.2.2");
    assert.equal(clientAddress(req("1.1.1.1, 2.2.2.2"), 0), "10.0.0.1");
  });
});

describe("disabled configuration", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  before(async () => (s = await serve({})));
  after(() => s.server.close());
  test("503 for every request when the key is not configured, even with a key sent", async () => {
    for (const path of ["/health", "/sales"]) {
      const r = await fetch(s.url(path), { headers: { "X-HRMS-Key": KEY } });
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as any).error.code, "HRMS_NOT_CONFIGURED");
    }
  });
});

describe("authentication and authorization", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  before(async () => (s = await serve({ HRMS_INTEGRATION_API_KEY: KEY }, { failedPerMinute: 1000 })));
  after(() => s.server.close());
  const ENDPOINTS = ["/health", "/sales", "/orders", "/leads", "/telecallers", "/employees", "/products", "/payments", "/marketing"];

  test("missing and wrong keys are 401 on every endpoint", async () => {
    for (const p of ENDPOINTS) {
      assert.equal((await fetch(s.url(p))).status, 401, p);
      assert.equal((await fetch(s.url(p), { headers: { "X-HRMS-Key": KEY + "x" } })).status, 401, p);
    }
  });
  test("the CRM's Authorization header is not accepted instead of the key", async () => {
    assert.equal((await fetch(s.url("/sales"), { headers: { Authorization: `Bearer ${KEY}` } })).status, 401);
  });
  test("the key in the query string is not accepted", async () => {
    assert.equal((await fetch(s.url(`/sales?key=${KEY}`))).status, 401);
  });
  test("the right key reads every endpoint with no-store headers", async () => {
    for (const p of ENDPOINTS) {
      const r = await fetch(s.url(p), { headers: { "X-HRMS-Key": KEY } });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
  });
  test("every non-GET method is rejected 405, with or without the key", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      for (const headers of [{ "X-HRMS-Key": KEY }, {}] as Record<string, string>[]) {
        const r = await fetch(s.url("/sales"), { method, headers });
        assert.equal(r.status, 405, `${method}`);
        assert.equal(r.headers.get("allow"), "GET");
      }
    }
  });
  test("unknown endpoint is 404 only with the key", async () => {
    assert.equal((await fetch(s.url("/nope"), { headers: { "X-HRMS-Key": KEY } })).status, 404);
    assert.equal((await fetch(s.url("/nope"))).status, 401);
  });
});

describe("rate limiting", () => {
  test("requests over the per-minute allowance get 429 with Retry-After", async () => {
    const s = await serve({ HRMS_INTEGRATION_API_KEY: KEY }, { perMinute: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(s.url("/health"), { headers: { "X-HRMS-Key": KEY } })).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
      const r = await fetch(s.url("/health"), { headers: { "X-HRMS-Key": KEY } });
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
    } finally {
      s.server.close();
    }
  });
  test("repeated wrong keys are throttled to 429", async () => {
    const s = await serve({ HRMS_INTEGRATION_API_KEY: KEY }, { failedPerMinute: 2 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await fetch(s.url("/health"), { headers: { "X-HRMS-Key": "wrong" } })).status);
      assert.deepEqual(codes, [401, 401, 429, 429]);
    } finally {
      s.server.close();
    }
  });
});

describe("request validation and response envelope", () => {
  let s: Awaited<ReturnType<typeof serve>>;
  before(async () => (s = await serve({ HRMS_INTEGRATION_API_KEY: KEY })));
  after(() => s.server.close());
  const get = (p: string) => fetch(s.url(p), { headers: { "X-HRMS-Key": KEY } });

  test("every report carries from, to, timezone and generatedAt", async () => {
    const body = (await (await get("/sales?range=last_7_days")).json()) as any;
    assert.equal(body.from, "2026-11-15");
    assert.equal(body.to, "2026-11-21");
    assert.equal(body.timezone, "Asia/Kolkata");
    assert.equal(body.generatedAt, NOW.toISOString());
    assert.equal(body.range.kind, "last_7_days");
  });
  test("bad ranges are 400", async () => {
    for (const q of ["range=forever", "range=custom", "range=custom&from=2026-02-30&to=2026-03-01", "range=custom&from=2026-03-05&to=2026-03-01", "range=custom&from=2026-11-01&to=2027-01-01", "range=today&from=2026-11-01"]) {
      const r = await get(`/sales?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(((await r.json()) as any).error.code, "INVALID_REQUEST");
    }
  });
  test("all_time starts at the first day with data", async () => {
    const body = (await (await get("/sales?range=all_time")).json()) as any;
    assert.equal(body.from, "2026-01-05");
    assert.equal(body.to, "2026-11-21");
  });
  test("a long custom range is accepted (no maximum)", async () => {
    const r = await get("/sales?range=custom&from=2024-01-01&to=2026-11-21");
    assert.equal(r.status, 200);
  });
  test("when every section fails the answer is 503, not a 200 of nulls", async () => {
    const failing = { ...stub, sales: async () => ({ data: { a: null }, availability: { a: { available: false, error: "x" } }, basis: {} }) } as unknown as HrmsReportingService;
    const f = await serve({ HRMS_INTEGRATION_API_KEY: KEY }, { service: failing });
    try {
      assert.equal((await fetch(f.url("/sales"), { headers: { "X-HRMS-Key": KEY } })).status, 503);
    } finally {
      f.server.close();
    }
  });
});

describe("logging never carries secrets", () => {
  test("rejections and errors log no key, header value or query string", async () => {
    const lines: string[] = [];
    const orig = { warn: logger.warn, error: logger.error, info: logger.info };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const k of ["warn", "error", "info"] as const) (logger as any)[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    const boom = { ...stub, sales: async () => { throw new Error("SECRET-CUSTOMER Asha 9876543210"); } } as unknown as HrmsReportingService;
    const s = await serve({ HRMS_INTEGRATION_API_KEY: KEY }, { service: boom });
    try {
      await fetch(s.url(`/sales?token=QUERYSECRET`), { headers: { "X-HRMS-Key": "WRONGKEYVALUE-123456" } });
      await fetch(s.url("/sales"), { method: "POST", headers: { "X-HRMS-Key": KEY } });
      const r = await fetch(s.url("/sales?note=QUERYSECRET"), { headers: { "X-HRMS-Key": KEY } });
      assert.equal(r.status, 500);
      const text = await r.text();
      assert.ok(!text.includes("9876543210") && !text.includes("Asha"));
    } finally {
      s.server.close();
      Object.assign(logger, orig);
    }
    const all = lines.join("\n");
    assert.ok(lines.length >= 3);
    for (const secret of [KEY, "WRONGKEYVALUE", "QUERYSECRET", "9876543210", "Asha"]) assert.ok(!all.includes(secret), `log contains ${secret}`);
  });
});
