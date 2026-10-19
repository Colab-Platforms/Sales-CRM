// CORS allow-list: exact origins only, nothing by default, never a wildcard (credentials are on), and a refused origin is a 403, not a server error. No database, no network beyond localhost.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";
import type { AddressInfo } from "node:net";
import { createCorsOptions, parseAllowedOrigins } from "./cors.js";
import { errorHandler } from "../middlewares/errorHandler.js";

describe("parseAllowedOrigins", () => {
  it("FRONTEND_URL behaves exactly as before: allowed with and without a trailing slash; nothing else is allowed by default", () => {
    assert.deepEqual(parseAllowedOrigins({ FRONTEND_URL: "https://app.example.com/" }).sort(), ["https://app.example.com", "https://app.example.com/"]);
    assert.deepEqual(parseAllowedOrigins({}), []);
  });
  it("CORS_ALLOWED_ORIGINS adds only exact http(s) origins; a wildcard, a path, another scheme or garbage is ignored", () => {
    const got = parseAllowedOrigins({ FRONTEND_URL: "https://app.example.com", CORS_ALLOWED_ORIGINS: "http://localhost:3000, *, http://localhost:3001/dashboard, ftp://x.example, not a url, https://other.example.com/," });
    assert.deepEqual(got.sort(), ["http://localhost:3000", "https://app.example.com", "https://other.example.com"].sort());
    assert.ok(!got.includes("*"));
  });
});

describe("the CORS middleware built from it", () => {
  async function preflight(env: Record<string, string | undefined>, origin?: string) {
    const app = express();
    app.use(cors(createCorsOptions(env, () => {})));
    app.post("/api/x", (_req, res) => { res.json({ ok: true }); });
    app.use((err: Error, _req: express.Request, _res: express.Response, next: express.NextFunction) => { const sink = console.error; console.error = () => {}; try { errorHandler(err, _req, _res, next); } finally { console.error = sink; } });
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/x`, { method: "OPTIONS", headers: { ...(origin ? { Origin: origin } : {}), "Access-Control-Request-Method": "POST" } });
      return { status: res.status, allowOrigin: res.headers.get("access-control-allow-origin"), credentials: res.headers.get("access-control-allow-credentials") };
    } finally {
      server.close();
    }
  }
  it("the configured production frontend still works; an unlisted origin (even localhost) is refused with 403 and gets no CORS headers", async () => {
    const env = { FRONTEND_URL: "https://app.example.com" };
    assert.deepEqual(await preflight(env, "https://app.example.com"), { status: 204, allowOrigin: "https://app.example.com", credentials: "true" });
    assert.deepEqual(await preflight(env, "http://localhost:3000"), { status: 403, allowOrigin: null, credentials: null });
  });
  it("an extra origin listed in CORS_ALLOWED_ORIGINS is allowed as that EXACT origin (never '*'), and other localhost ports stay refused", async () => {
    const env = { FRONTEND_URL: "https://app.example.com", CORS_ALLOWED_ORIGINS: "http://localhost:3000" };
    assert.deepEqual(await preflight(env, "http://localhost:3000"), { status: 204, allowOrigin: "http://localhost:3000", credentials: "true" });
    assert.equal((await preflight(env, "http://localhost:3001")).status, 403);
    assert.equal((await preflight({ ...env, CORS_ALLOWED_ORIGINS: "*" }, "http://localhost:3000")).status, 403, "a wildcard setting allows nothing");
  });
  it("requests without an Origin (server-to-server, webhooks, curl) are unaffected", async () => {
    assert.equal((await preflight({ FRONTEND_URL: "https://app.example.com" })).status, 204);
  });
});
