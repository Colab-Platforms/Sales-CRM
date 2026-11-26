// The DEMO API's isolation guarantees. No database, no network beyond localhost.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "throwaway-test-secret-for-demo";
const { createDemoRouter } = await import("./demo.routes.js");
const { clearDemoSessions, signDemoToken, verifyDemoToken } = await import("./demo.session.js");
const { buildDemoWorld } = await import("./demo.data.js");
const { verifyToken, signToken } = await import("../../lib/jwt.js");
const { requireAuth } = await import("../../middlewares/auth.js");

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

describe("the demo module cannot reach production data or an integration", () => {
  it("imports only its own files, express, jsonwebtoken and node:crypto - no Prisma, database, Shopify, Cashfree, Shiprocket, WhatsApp, email, calling or HTTP client", () => {
    const allowed = new Set(["express", "jsonwebtoken", "node:crypto"]);
    for (const file of sources) {
      const text = readFileSync(join(here, file), "utf8");
      const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!).concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!), [...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!));
      for (const s of specifiers) assert.ok(s.startsWith("./") || allowed.has(s), `${file} imports "${s}"`);
      assert.ok(!/\b(fetch|XMLHttpRequest|axios|process\.env\.DATABASE_URL|prisma|\$queryRaw|createTransport|sendMail|child_process)\b/.test(text.replace(/\/\/.*$/gm, "")), `${file} mentions a network, database or mail API`);
    }
  });
});

describe("the fictional world", () => {
  const w = buildDemoWorld(Date.UTC(2026, 10, 26, 6, 0));
  it("is large enough to look populated, and every record is fictional: example.com e-mail, +91 00000 numbers no real person can have", () => {
    assert.ok(w.leads.length >= 400 && w.orders.length >= 60 && w.calls.length >= 400 && w.tasks.length >= 20 && w.users.length >= 10);
    for (const u of w.users) assert.ok(/@example\.com$/.test(u.email) && /^\+9100000\d{5}$/.test(u.phone) && /^demo\./.test(u.username), u.username);
    for (const l of w.leads) assert.ok(/@example\.com$/.test(l.email) && /^\+9100000\d{5}$/.test(l.mobile), l.leadNumber);
    assert.ok(w.leads.every((l) => /^(Sample|Demo|Example|Specimen|Mockwala|Testkar|Placeholder|Fictional)$/.test(l.lastName)));
  });
  it("is deterministic for the same moment", () => {
    assert.deepEqual(buildDemoWorld(5_000_000_000_000).leads.slice(0, 5), buildDemoWorld(5_000_000_000_000).leads.slice(0, 5));
  });
});

describe("tokens never cross", () => {
  it("a demo token is rejected by the real auth; a real token is rejected by the demo guard", () => {
    const demo = signDemoToken({ sub: "de300000-0001-4000-8000-000000000001", sid: "s1", role: "ADMIN", demo: true });
    assert.throws(() => verifyToken(demo), { statusCode: 401 });
    let error: unknown = null;
    try {
      requireAuth({ headers: { authorization: `Bearer ${demo}` } } as never, {} as never, ((e?: unknown) => (error = e ?? null)) as never);
    } catch (e) {
      error = e; // the real guard rejects by throwing
    }
    assert.equal((error as { statusCode?: number } | null)?.statusCode, 401);
    const real = signToken({ sub: "11111111-1111-4111-8111-111111111111", role: "ADMIN", username: "someone" });
    assert.equal(verifyDemoToken(real), null);
    assert.equal(verifyDemoToken(jwt.sign({ sub: "x", sid: "s", role: "ADMIN", demo: true }, process.env.JWT_SECRET!)), null, "signed with the real secret itself: refused");
    assert.equal(verifyDemoToken(jwt.sign({ sub: "x", sid: "s", role: "ADMIN" }, "anything")), null);
  });
});

async function serve(env: Record<string, string | undefined>) {
  const app = express();
  app.use(express.json());
  app.use("/api/demo", createDemoRouter(env));
  app.use("/api", (_req, res) => void res.status(599).json({ reachedRealApi: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  type Reply = { status: number; body: any };
  const call = async (method: string, path: string, token?: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => server.close() };
}

describe("the demo API", () => {
  it("is OFF by default: every demo path is a 404 and no session can start", async () => {
    const s = await serve({});
    try {
      assert.equal((await s.call("POST", "/demo/session")).status, 404);
      assert.equal((await s.call("GET", "/demo/dashboard")).status, 404);
      const off = await serve({ DEMO_MODE_ENABLED: "false" });
      assert.equal((await off.call("POST", "/demo/session")).status, 404);
      off.close();
    } finally {
      s.close();
    }
  });

  it("an access code from the environment protects the entry; without one the entry page alone is the gate", async () => {
    clearDemoSessions();
    const guarded = await serve({ DEMO_MODE_ENABLED: "true", DEMO_ACCESS_CODE: "open-sesame" });
    try {
      assert.equal((await guarded.call("POST", "/demo/session", undefined, {})).status, 403);
      assert.equal((await guarded.call("POST", "/demo/session", undefined, { accessCode: "wrong" })).status, 403);
      assert.equal((await guarded.call("POST", "/demo/session", undefined, { accessCode: "open-sesame" })).status, 200);
    } finally {
      guarded.close();
    }
  });

  it("without a demo token nothing is served, a real-looking token is refused, and unknown paths are never forwarded to the real API", async () => {
    const s = await serve({ DEMO_MODE_ENABLED: "true" });
    try {
      for (const path of ["/demo/dashboard", "/demo/lead/leads", "/demo/orders/live", "/demo/auth/me"]) assert.equal((await s.call("GET", path)).status, 401, path);
      assert.equal((await s.call("GET", "/demo/dashboard", signToken({ sub: "11111111-1111-4111-8111-111111111111", role: "ADMIN", username: "x" }))).status, 401);
      const { body } = await s.call("POST", "/demo/session");
      const token = body.data.accessToken as string;
      const unknown = await s.call("GET", "/demo/lead/leads/not-a-thing/secret", token);
      assert.equal(unknown.status, 404);
      assert.notEqual(unknown.body?.reachedRealApi, true);
      assert.match(unknown.body.message, /not available in the demo/);
    } finally {
      s.close();
    }
  });

  it("starts as Admin, switches roles on the server, and each role sees only its own records", async () => {
    clearDemoSessions();
    const s = await serve({ DEMO_MODE_ENABLED: "true" });
    try {
      const start = (await s.call("POST", "/demo/session")).body.data;
      assert.deepEqual([start.user.role, start.user.demo], ["ADMIN", true]);
      const switchTo = async (token: string, role: string) => (await s.call("POST", "/demo/session/role", token, { role })).body.data;
      assert.equal((await s.call("POST", "/demo/session/role", start.accessToken, { role: "SUPERUSER" })).status, 400);
      const admin = start.accessToken as string;
      const manager = (await switchTo(admin, "MANAGER")).accessToken as string;
      const tele = (await switchTo(manager, "SALESPERSON")).accessToken as string;
      const total = async (token: string) => (await s.call("GET", "/demo/lead/leads?limit=100", token)).body.data.pagination.total as number;
      const [a, m, t] = [await total(admin), await total(manager), await total(tele)];
      assert.ok(a > m && m > t && t > 20, `${a} > ${m} > ${t}`);

      const meM = (await s.call("GET", "/demo/auth/me", manager)).body.data;
      const meT = (await s.call("GET", "/demo/auth/me", tele)).body.data;
      assert.deepEqual([meM.role, meT.role, meM.demo, meT.demo], ["MANAGER", "SALESPERSON", true, true]);
      // manager: only leads of the manager's own team; telecaller: only leads assigned to that telecaller
      const mLeads = (await s.call("GET", "/demo/lead/leads?limit=100&page=1", manager)).body.data.data as { assignedManager: { id: string } | null }[];
      assert.ok(mLeads.every((l) => l.assignedManager?.id === meM.id));
      const tLeads = (await s.call("GET", "/demo/lead/leads?limit=100", tele)).body.data.data as { owner: { id: string } | null }[];
      assert.ok(tLeads.every((l) => l.owner?.id === meT.id));
      // a record outside the role's scope is simply not found
      const aLeads = (await s.call("GET", "/demo/lead/leads?limit=100", admin)).body.data.data as { id: string; owner: { id: string } | null }[];
      const foreign = aLeads.find((l) => l.owner && l.owner.id !== meT.id)!;
      assert.equal((await s.call("GET", `/demo/lead/leads/${foreign.id}`, tele)).status, 404);
      assert.equal((await s.call("GET", `/demo/calling/leads/${foreign.id}/calls`, tele)).status, 404);
      // role-specific dashboards and screens
      assert.equal((await s.call("GET", "/demo/dashboard", admin)).body.data.role, "ADMIN");
      assert.equal((await s.call("GET", "/demo/dashboard", manager)).body.data.role, "MANAGER");
      assert.equal((await s.call("GET", "/demo/dashboard", tele)).body.data.role, "SALESPERSON");
      assert.equal((await s.call("GET", "/demo/manager/analytics?from=2026-01-01&to=2026-12-31", tele)).status, 403);
      assert.equal((await s.call("GET", "/demo/admin/salespersons", manager)).status, 403);
      assert.equal((await s.call("GET", "/demo/admin/salespersons", admin)).status, 200);
      const sales = (await s.call("GET", "/demo/manager/analytics?from=2026-01-01&to=2026-12-31", manager)).body.data;
      assert.equal(sales.salespeople.length, 4, "the manager's team only");
      assert.equal((await s.call("GET", "/demo/manager/analytics?from=2026-01-01&to=2026-12-31", admin)).body.data.salespeople.length, 7);
      const orders = async (token: string) => (await s.call("GET", "/demo/orders/live?first=100", token)).body.data.items as { salesperson: { id: string } | null }[];
      assert.ok((await orders(tele)).every((o) => o.salesperson?.id === meT.id));
      assert.ok((await orders(admin)).length > (await orders(tele)).length);
    } finally {
      s.close();
    }
  });

  it("every write is refused except the few that change only the session's own copy of the data; real-world actions are all refused", async () => {
    clearDemoSessions();
    const s = await serve({ DEMO_MODE_ENABLED: "true" });
    try {
      const token = (await s.call("POST", "/demo/session")).body.data.accessToken as string;
      const blocked: [string, string, unknown?][] = [
        ["POST", "/demo/orders", { leadId: "x" }], ["POST", "/demo/orders/abc/cancel"], ["POST", "/demo/orders/abc/payment-links"], ["POST", "/demo/orders/abc/shipments"], ["POST", "/demo/orders/live/export", { filters: {} }],
        ["POST", "/demo/payments/links"], ["POST", "/demo/shipments"], ["POST", "/demo/whatsapp/messages", { to: "+910000000000" }], ["POST", "/demo/whatsapp/campaigns/x/send"],
        ["POST", "/demo/calling/leads/abc/call"], ["POST", "/demo/integrations/shopify/sync"], ["POST", "/demo/lead/leads", { firstName: "x" }], ["DELETE", "/demo/lead/leads/abc"],
        ["PUT", "/demo/admin/users/abc"], ["POST", "/demo/admin/salespersons", { name: "x" }], ["POST", "/demo/lead/leads/import/file"], ["POST", "/demo/refund-requests"], ["POST", "/demo/report-automation/send"],
        ["POST", "/demo/auth/login", { username: "admin", password: "x" }],
      ];
      for (const [method, path, body] of blocked) {
        const r = await s.call(method, path, token, body);
        assert.equal(r.status, 403, `${method} ${path} -> ${r.status}`);
        assert.match(r.body.message, /disabled in the demo/);
      }
      // the allowed edits change this session only: a second session starts from the untouched world
      const lead = (await s.call("GET", "/demo/lead/leads?limit=1", token)).body.data.data[0] as { id: string; workingStatus: string };
      const newStatus = lead.workingStatus === "CONVERTED" ? "BUSY" : "CONVERTED";
      assert.equal((await s.call("PATCH", `/demo/lead/leads/${lead.id}`, token, { workingStatus: newStatus })).body.data.workingStatus, newStatus);
      assert.equal((await s.call("GET", `/demo/lead/leads/${lead.id}`, token)).body.data.workingStatus, newStatus);
      const other = (await s.call("POST", "/demo/session")).body.data.accessToken as string;
      assert.equal((await s.call("GET", `/demo/lead/leads/${lead.id}`, other)).body.data.workingStatus, lead.workingStatus);
    } finally {
      s.close();
    }
  });

  it("the entry endpoint brakes a flood of session starts", async () => {
    clearDemoSessions();
    const s = await serve({ DEMO_MODE_ENABLED: "true" });
    try {
      let last = 200;
      for (let i = 0; i < 40; i++) last = (await s.call("POST", "/demo/session")).status;
      assert.equal(last, 429);
    } finally {
      s.close();
      clearDemoSessions();
    }
  });
});
