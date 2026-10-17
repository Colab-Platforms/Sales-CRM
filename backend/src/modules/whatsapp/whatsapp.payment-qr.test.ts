// No database: the public backend address, the image URL, the PNG, and the error redaction.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { resolvePublicBackendUrl } from "../cashfree/cashfree.config.js";
import { isCashfreePaymentUrl, paymentQrImageUrl, qrCaption, redactProviderError, renderPaymentQrPng } from "./whatsapp.payment-qr.js";

const PAYMENT_ID = "3f0c9a52-6f43-4d5e-9b61-0c1a2b3c4d5e";
const TOKEN = "a".repeat(32);

describe("the public backend address (PUBLIC_BACKEND_URL) behind the QR image URL", () => {
  it("is the configured https address, without a trailing slash; Render's own RENDER_EXTERNAL_URL is the fallback", () => {
    assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: "https://sales-crm-3pan.onrender.com/" }), "https://sales-crm-3pan.onrender.com");
    assert.equal(resolvePublicBackendUrl({ RENDER_EXTERNAL_URL: "https://sales-crm-3pan.onrender.com" }), "https://sales-crm-3pan.onrender.com");
    assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: "https://a.example.com", RENDER_EXTERNAL_URL: "https://b.example.com" }), "https://a.example.com", "the explicit setting wins");
  });
  it("is never an unreachable address: unset, http, localhost and private addresses give null (so the CRM says what to configure instead of sending a dead link)", () => {
    for (const bad of [undefined, "", "http://sales-crm-3pan.onrender.com", "https://localhost:5000", "https://127.0.0.1", "https://192.168.1.4", "not a url"]) assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: bad }), null, String(bad));
    assert.equal(resolvePublicBackendUrl({}), null);
  });
});

describe("the QR image URL and the image itself", () => {
  it("is https on the public host, on the public-qr route, for exactly this payment and token (a trailing slash on the base never doubles up)", () => {
    const url = paymentQrImageUrl("https://sales-crm-3pan.onrender.com/", PAYMENT_ID, TOKEN);
    assert.equal(url, `https://sales-crm-3pan.onrender.com/api/public/payment-qr/${PAYMENT_ID}/${TOKEN}.png`);
    assert.equal(new URL(url).protocol, "https:");
  });
  it("renders a valid PNG that encodes exactly the Cashfree payment URL, and a different URL gives a different image", async () => {
    const link = "https://payments.cashfree.com/links/abcd1234efgh5678";
    const png = await renderPaymentQrPng(link);
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.ok(png.length > 500);
    const encoded = QRCode.create(link, {}).segments.map((s) => Buffer.from(s.data as never).toString()).join("");
    assert.equal(encoded, link);
    assert.ok(!png.equals(await renderPaymentQrPng("https://payments.cashfree.com/links/zzzz9999yyyy8888")));
  });
  it("only a real Cashfree payment page is ever encoded", () => {
    assert.equal(isCashfreePaymentUrl("https://payments.cashfree.com/links/x"), true);
    assert.equal(isCashfreePaymentUrl("https://payments-test.cashfree.com/links/x"), true);
    for (const bad of [null, undefined, "", "http://payments.cashfree.com/links/x", "https://evilcashfree.com/links/x", "https://cashfree.com.evil.example/x", "javascript:alert(1)"]) assert.equal(isCashfreePaymentUrl(bad as never), false, String(bad));
  });
  it("the caption carries the order reference and the payable amount", () => {
    assert.match(qrCaption("CRM-1", "INR", "599"), /₹599\.00 for order CRM-1/);
  });
  it("provider errors shown to a person never carry credential-like text", () => {
    const shown = redactProviderError("Request failed: Bearer EAABsbCS1iHgBO7ZAbc123 token=abc123secret expired");
    assert.ok(!/EAAB|abc123/.test(shown), shown);
  });
});

describe("the URL the sender builds is the route the application registers", () => {
  it("path = /api + the mount in routes.ts + /:paymentId/:token.png (no stale /signature variant), and the route is mounted before any auth", async () => {
    const { readFileSync } = await import("node:fs");
    const routes = readFileSync(new URL("../../routes.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
    const mount = /router\.use\("([^"]+)",\s*publicQrRoutes\)/.exec(routes)?.[1];
    assert.equal(mount, "/public/payment-qr");
    assert.match(server, /app\.use\("\/api",\s*routes\)/, "routes.ts is served under /api");
    assert.ok(routes.indexOf("publicQrRoutes)") < routes.indexOf('router.use("/auth"'), "mounted ahead of the authenticated routers");
    const path = new URL(paymentQrImageUrl("https://sales-crm-3pan.onrender.com", PAYMENT_ID, TOKEN)).pathname;
    assert.equal(path, `/api${mount}/${PAYMENT_ID}/${TOKEN}.png`);
    assert.ok(!/signature/i.test(path));
  });
});
