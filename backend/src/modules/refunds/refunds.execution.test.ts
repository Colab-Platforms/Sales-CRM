import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CashfreeClient, parseRefund } from "../cashfree/cashfree.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import { mapProviderStatus, refundEnvironmentBlock, refundIdFor } from "./refunds.execution.js";

const ENV = { CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP_ID", CASHFREE_CLIENT_SECRET: "test-secret-not-real" };
const sandbox = loadCashfreeConfig({ ...ENV, CASHFREE_ENV: "sandbox" });

describe("Cashfree Create Refund / Get Refund (client)", () => {
  const capture = (answer: unknown, status = 200) => {
    const seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer), { status });
    }) as unknown as typeof fetch;
    return { seen, client: new CashfreeClient(sandbox, f) };
  };
  const ANSWER = { cf_refund_id: "R1", refund_id: "rf1", order_id: "CFPay_o1", refund_status: "PENDING", refund_amount: 100, refund_currency: "INR" };

  it("POSTs to the sandbox host /orders/{cashfree order_id}/refunds with amount, refund_id, note, speed, auth, version and an idempotency key", async () => {
    const { seen, client } = capture(ANSWER);
    const out = await client.createRefund("CFPay_o1", { refund_amount: 100, refund_id: "rfabc123", refund_note: "CRM refund ZZ-1", refund_speed: "STANDARD" }, "6f1b3c7e-0000-4000-8000-000000000001");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.url, "https://sandbox.cashfree.com/pg/orders/CFPay_o1/refunds");
    assert.deepEqual(seen[0]!.body, { refund_amount: 100, refund_id: "rfabc123", refund_note: "CRM refund ZZ-1", refund_speed: "STANDARD" });
    const h = seen[0]!.headers;
    assert.equal(h["x-client-id"], "TEST_APP_ID");
    assert.ok(h["x-client-secret"] && h["x-api-version"] && h["x-request-id"]);
    assert.equal(h["x-idempotency-key"], "6f1b3c7e-0000-4000-8000-000000000001");
    assert.deepEqual([out.cfRefundId, out.refundId, out.refundStatus, out.refundAmount], ["R1", "rf1", "PENDING", "100"]);
  });

  it("GETs /orders/{order_id}/refunds/{refund_id} (read-only) and url-encodes the ids", async () => {
    const { seen, client } = capture(ANSWER);
    await client.getRefund("CFPay o1", "rf1");
    assert.deepEqual([seen[0]!.method, seen[0]!.url], ["GET", "https://sandbox.cashfree.com/pg/orders/CFPay%20o1/refunds/rf1"]);
    assert.equal(seen[0]!.body, undefined);
  });

  it("a malformed answer is an error, never a refund", async () => {
    assert.equal(parseRefund({}), null);
    assert.equal(parseRefund({ refund_id: "x" }), null);
    const { client } = capture({ something: "else" });
    await assert.rejects(client.createRefund("o", { refund_amount: 1, refund_id: "rf1", refund_note: "abc", refund_speed: "STANDARD" }, "k"), /without refund details/);
  });

  it("the sandbox config can only ever reach the sandbox host", async () => {
    const { seen, client } = capture(ANSWER);
    await client.createRefund("o", { refund_amount: 1, refund_id: "rf1", refund_note: "abc", refund_speed: "STANDARD" }, "k");
    assert.ok(seen.every((s) => s.url.startsWith("https://sandbox.cashfree.com/pg/")));
    assert.ok(!seen.some((s) => s.url.includes("api.cashfree.com")));
  });
});

describe("refund id", () => {
  it("is derived from the request id: 3-40 alphanumeric characters and identical on every call", () => {
    const id = "6f1b3c7e-1234-4abc-9def-0123456789ab";
    assert.equal(refundIdFor(id), "rf6f1b3c7e12344abc9def0123456789ab");
    assert.equal(refundIdFor(id), refundIdFor(id));
    assert.match(refundIdFor(id), /^[A-Za-z0-9]{3,40}$/);
    assert.notEqual(refundIdFor(id), refundIdFor("6f1b3c7e-1234-4abc-9def-0123456789ac"));
  });
});

describe("Cashfree refund status mapping", () => {
  it("only SUCCESS completes; CANCELLED/REJECTED fail; everything else (and anything unknown) stays PROCESSING", () => {
    assert.equal(mapProviderStatus("SUCCESS"), "COMPLETED");
    assert.equal(mapProviderStatus("success"), "COMPLETED");
    for (const s of ["CANCELLED", "REJECTED"]) assert.equal(mapProviderStatus(s), "FAILED");
    for (const s of ["PENDING", "PENDING_APPROVAL", "ONHOLD", "SOMETHING_NEW", "", null, undefined]) assert.equal(mapProviderStatus(s as string), "PROCESSING", String(s));
  });
});

describe("environment guard", () => {
  it("sandbox is allowed; production is refused unless explicitly switched on", () => {
    assert.equal(refundEnvironmentBlock(sandbox, {}), null);
    const prod = loadCashfreeConfig({ ...ENV, CASHFREE_ENV: "production" });
    assert.match(refundEnvironmentBlock(prod, {})!, /sandbox/);
    assert.match(refundEnvironmentBlock(prod, { CASHFREE_ALLOW_PRODUCTION_REFUNDS: "yes" })!, /sandbox/);
    assert.equal(refundEnvironmentBlock(prod, { CASHFREE_ALLOW_PRODUCTION_REFUNDS: "true" }), null);
  });
});

describe("no refund call exists outside the refund execution path", () => {
  it("payment-link creation / refresh / cancel and the webhook code never call a refund endpoint", () => {
    const dir = new URL("../cashfree/", import.meta.url);
    for (const f of ["cashfree.payments.service.ts", "cashfree.apply.ts", "cashfree.webhook.processor.ts", "cashfree.webhook.handler.ts"]) {
      const code = readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, /createRefund|getRefund|\/refunds/i, f);
    }
  });
});
