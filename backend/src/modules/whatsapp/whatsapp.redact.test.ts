import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logger } from "@/utils/logger.js";
import { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import { redactDeep, redactSecrets } from "./whatsapp.redact.js";

const TOKEN = "plain-access-token-not-pattern-shaped-9981";
const APP_SECRET = "app-secret-value-7731";
const creds = { phoneNumberId: "PHONE-1", businessAccountId: "WABA-1", accessToken: TOKEN, appSecret: APP_SECRET, verifyToken: "verify-token-5521", graphApiVersion: "v21.0" };

describe("redactSecrets", () => {
  it("removes bearer tokens, Meta/Cashfree/Shopify/JWT shaped credentials and key=value secrets, and keeps the rest", () => {
    assert.equal(redactSecrets("rejected with Bearer TEST_SECRET_TOKEN (code 190)"), "rejected with Bearer [REDACTED] (code 190)");
    assert.equal(redactSecrets("Invalid OAuth access token EAAGabc123XYZ789"), "Invalid OAuth access token [REDACTED]");
    assert.ok(!redactSecrets("x cfsk_ma_prod_abc123_def and shpat_0123456789abcdef").includes("cfsk_ma"));
    assert.ok(!redactSecrets("https://graph.facebook.com/x?access_token=SECRET123&a=1").includes("SECRET123"));
    assert.ok(!redactSecrets("Authorization: abc.def.ghi").includes("abc.def.ghi"));
    assert.equal(redactSecrets("Template does not exist (code 132001, trace Axyz)"), "Template does not exist (code 132001, trace Axyz)");
  });
  it("removes configured exact secrets wherever they appear (even if not credential-shaped)", () => {
    assert.equal(redactSecrets(`oops ${TOKEN} and ${APP_SECRET}`, [TOKEN, APP_SECRET]), "oops [REDACTED] and [REDACTED]");
  });
  it("redactDeep cleans nested bodies and blanks header-like keys", () => {
    const out = JSON.stringify(redactDeep({ error: { message: `bad ${TOKEN}`, code: 190 }, headers: { authorization: "Bearer zzz" }, list: [`Bearer abc`] }, [TOKEN]));
    assert.ok(!out.includes(TOKEN) && !out.includes("zzz") && !out.includes("Bearer abc"));
    assert.ok(out.includes("190"));
  });
});

describe("Meta rejection: nothing secret leaves the provider, useful detail stays", () => {
  const rejectWith = (message: string, details?: string) =>
    (async () => new Response(JSON.stringify({ error: { message, type: "OAuthException", code: 190, error_subcode: 463, fbtrace_id: "TRACE1", ...(details ? { error_data: { details } } : {}) } }), { status: 401 })) as unknown as typeof fetch;

  for (const [label, message, details] of [
    ["the configured access token", `Invalid OAuth access token ${TOKEN}`, undefined],
    ["a bearer token", "Request failed with Bearer TEST_SECRET_TOKEN", undefined],
    ["the app secret in details", "Application error", `secret ${APP_SECRET} rejected`],
  ] as const) {
    it(`${label} echoed by Meta is redacted from the error message, its attached body and the logs - while status, code, subcode and trace remain`, async () => {
      const logged: unknown[] = [];
      const original = logger.error;
      (logger as any).error = (...args: unknown[]) => { logged.push(args); };
      try {
        const meta = new MetaCloudApiProvider(creds, { fetchImpl: rejectWith(message, details) });
        const error: any = await meta.sendTemplateMessage({ to: "+919876543210", templateName: "prepaid_template", params: ["a"], paramNames: ["customer_name"], languageCode: "en" } as never).then(() => null, (e) => e);
        assert.ok(error instanceof WhatsAppSendError);
        const everything = JSON.stringify({ message: error.message, raw: error.raw, logged });
        for (const secret of [TOKEN, APP_SECRET, "TEST_SECRET_TOKEN"]) assert.equal(everything.includes(secret), false, `${secret} must not appear`);
        assert.match(error.message, /HTTP 401/);
        assert.match(error.message, /code 190/);
        assert.match(error.message, /subcode 463/);
        assert.match(error.message, /trace TRACE1/);
        assert.equal((error.raw as { error: { type: string } }).error.type, "OAuthException");
        assert.ok(logged.length > 0, "the rejection is still logged for diagnosis");
      } finally {
        (logger as any).error = original;
      }
    });
  }

  it("a network failure whose message contains a credential is redacted too", async () => {
    const fetchImpl = (async () => { throw new Error(`connect ECONNRESET while sending Bearer ${TOKEN}`); }) as unknown as typeof fetch;
    const error: any = await new MetaCloudApiProvider(creds, { fetchImpl }).sendTemplateMessage({ to: "+91", templateName: "x", params: [], languageCode: "en" } as never).then(() => null, (e) => e);
    assert.ok(!JSON.stringify({ m: error.message, r: error.raw }).includes(TOKEN));
    assert.match(error.message, /ECONNRESET/);
  });
});
