// The sandbox fail-fast guard: a sandbox run refuses anything that could reach production, a normal process is never affected, and no message ever contains a value.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSandboxProcess, isSandboxProcess, sandboxProblems } from "./cashfree.sandbox-guard.js";
import { CashfreeConfigError, loadCashfreeConfig, loadCashfreeWebhookConfig } from "./cashfree.config.js";

const good: Record<string, string> = {
  CRM_SANDBOX_MODE: "true",
  CASHFREE_ENABLED: "true",
  CASHFREE_ENV: "sandbox",
  CASHFREE_CLIENT_ID: "sandbox-id-value",
  CASHFREE_CLIENT_SECRET: "sandbox-secret-value",
  CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED: "true",
  CASHFREE_UPI_QR_ENABLED: "true",
  PUBLIC_BACKEND_URL: "https://sandbox-tunnel.example.com",
  DATABASE_URL: "postgresql://user:pw-value@127.0.0.1:5544/crm_sandbox",
};
const without = (...names: string[]) => Object.fromEntries(Object.entries(good).filter(([k]) => !names.includes(k)));
const joined = (env: Record<string, string>) => sandboxProblems(env).join(" | ");

describe("sandbox guard", () => {
  it("a normal (non-sandbox) process is never affected, whatever its configuration", () => {
    assert.equal(isSandboxProcess({}), false);
    assert.deepEqual(sandboxProblems({ CASHFREE_ENV: "production", DATABASE_URL: "postgresql://u:p@ep-gentle-rice-b3jims4e.example/neondb" }), []);
    assert.doesNotThrow(() => assertSandboxProcess({ CASHFREE_ENV: "production" }));
  });

  it("a correct sandbox configuration passes", () => {
    assert.deepEqual(sandboxProblems(good), []);
    assert.doesNotThrow(() => assertSandboxProcess(good));
    assert.doesNotThrow(() => assertSandboxProcess({ ...good, DATABASE_URL: "postgresql://u:p@db.neon.example/my_test_db?sslmode=require" }));
  });

  it("refuses production or an unspecified Cashfree environment, a production URL, and a production override", () => {
    assert.match(joined({ ...good, CASHFREE_ENV: "production" }), /CASHFREE_ENV must be explicitly sandbox/);
    assert.match(joined(without("CASHFREE_ENV")), /CASHFREE_ENV must be explicitly sandbox/, "the sandbox default is not enough - it must be explicit");
    assert.match(joined({ ...good, CASHFREE_API_URL: "https://api.cashfree.com/pg" }), /CASHFREE_API_URL points at the production Cashfree host/);
    assert.match(joined({ ...good, CASHFREE_UPI_QR_ALLOW_PRODUCTION: "true" }), /CASHFREE_UPI_QR_ALLOW_PRODUCTION/);
  });

  it("refuses the production database, and any database that is not obviously throw-away", () => {
    assert.match(joined({ ...good, DATABASE_URL: "postgresql://u:p@ep-gentle-rice-b3jims4e-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb" }), /DATABASE_URL points at a production database host/);
    assert.match(joined({ ...good, DATABASE_URL: "postgresql://u:p@some-other-host.example.com/neondb" }), /DATABASE_URL must be a local database or one whose name contains sandbox, test or iso/);
    assert.match(joined({ ...good, CRM_PRODUCTION_DB_HOSTS: "prod-db.example.com", DATABASE_URL: "postgresql://u:p@prod-db.example.com/crm_test" }), /production database host/);
    assert.match(joined(without("DATABASE_URL")), /DATABASE_URL is missing/);
    assert.match(joined({ ...good, QUEUE_DATABASE_URL: "postgresql://u:p@ep-gentle-rice-b3jims4e.example/neondb" }), /QUEUE_DATABASE_URL points at a production database host/);
  });

  it("refuses live WhatsApp / Shopify, a missing or production webhook address, disabled flags, and unconfirmed credentials", () => {
    assert.match(joined({ ...good, WHATSAPP_PROVIDER: "AISENSY" }), /WHATSAPP_PROVIDER must be unset/);
    assert.match(joined({ ...good, SHOPIFY_SYNC_ENABLED: "true" }), /SHOPIFY_SYNC_ENABLED must not be true/);
    assert.match(joined(without("PUBLIC_BACKEND_URL")), /PUBLIC_BACKEND_URL must be the public https address/);
    assert.match(joined({ ...good, PUBLIC_BACKEND_URL: "http://localhost:5100" }), /PUBLIC_BACKEND_URL must be the public https address/);
    assert.match(joined({ ...good, CRM_PRODUCTION_BACKEND_HOSTS: "crm.onrender.com", PUBLIC_BACKEND_URL: "https://crm.onrender.com" }), /production backend/);
    assert.match(joined(without("CASHFREE_UPI_QR_ENABLED")), /CASHFREE_UPI_QR_ENABLED must be true/);
    assert.match(joined(without("CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED")), /CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED=true is required/);
  });

  it("messages name variables and rules only - never a value", () => {
    const text = joined({ ...good, CASHFREE_ENV: "production", DATABASE_URL: "postgresql://user:pw-value@ep-gentle-rice-b3jims4e.example/neondb", WHATSAPP_PROVIDER: "AISENSY" });
    for (const secret of ["pw-value", "sandbox-secret-value", "sandbox-id-value", "AISENSY", "neondb"]) assert.ok(!text.includes(secret), secret);
  });

  it("the Cashfree configuration itself refuses to load, and the webhook endpoint accepts nothing, while a sandbox run is misconfigured", () => {
    const bad = { ...good, CASHFREE_ENV: "production" };
    assert.throws(() => loadCashfreeConfig(bad), (e) => e instanceof CashfreeConfigError && /Sandbox run refused/.test((e as Error).message) && !(e as Error).message.includes("sandbox-secret-value"));
    assert.equal(loadCashfreeWebhookConfig(bad), null);
    const ok = loadCashfreeConfig(good);
    assert.equal(ok.environment, "sandbox");
    assert.equal(ok.baseUrl, "https://sandbox.cashfree.com/pg");
    assert.ok(loadCashfreeWebhookConfig(good));
  });
});

describe("sandbox guard - values that look filled in but are not accepted", () => {
  it("the template placeholder is NOT a database URL, and the credentials confirmation must be exactly true", () => {
    const placeholder = "postgresql://<user>:<password>@<non-production-host>/<db-name-containing-sandbox>?sslmode=require";
    assert.match(joined({ ...good, DATABASE_URL: placeholder }), /DATABASE_URL is missing or is not a database URL/);
    assert.match(joined({ ...good, DATABASE_URL: "" }), /DATABASE_URL is missing or is not a database URL/);
    for (const value of ["false", "", "TRUE-ish", "true # confirmed", "yes", "1"]) {
      assert.match(joined({ ...good, CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED: value }), /CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED=true is required/, JSON.stringify(value));
    }
    assert.deepEqual(sandboxProblems({ ...good, CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED: " TRUE " }), [], "case and surrounding spaces are tolerated");
  });
});
