// Unit tests for the dynamic UPI QR pieces that need no database: the Cashfree request/response handling, the sandbox-only gate, deterministic ids and the payment verification. Nothing real is called.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CashfreeClient, parseOrder, parseUpiQrPay, PNG_SIGNATURE } from "./cashfree.client.js";
import { loadCashfreeConfig, upiQrBlockReason } from "./cashfree.config.js";
import QRCode from "qrcode";
import { idempotencyKeyFor, qrOrderIdFor, readStoredUpiQr, verifyQrOrderPaid } from "./cashfree.upi-qr.js";
import { assertDirectUpiQr, decodeQrPng, inspectQrText } from "./cashfree.upi-qr-decode.js";

const pngBytes = (size = 400) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(size, 7)]);
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
const payAnswer = (qrcode: unknown, extra: Record<string, unknown> = {}) => ({ action: "custom", cf_payment_id: "555", channel: "qrcode", payment_amount: 249, data: { payload: { qrcode }, url: null }, ...extra });

describe("parseUpiQrPay - fails closed on anything that is not a usable PNG", () => {
  it("accepts a PNG data URI (also with line breaks inside the base64), returning the bytes", () => {
    const png = pngBytes();
    const wrapped = dataUrl(png).replace(/(.{76})/g, "$1\n");
    for (const value of [dataUrl(png), wrapped, `  ${dataUrl(png)}  `]) {
      const parsed = parseUpiQrPay(payAnswer(value));
      assert.ok(parsed);
      assert.ok(parsed.png.equals(png));
      assert.equal(parsed.cfPaymentId, "555");
      assert.equal(parsed.paymentAmount, "249");
    }
  });
  it("a bare base64 string (no data:image/png;base64, prefix) is NOT the supplied schema and is refused", () => {
    assert.equal(parseUpiQrPay(payAnswer(pngBytes().toString("base64"))), null);
  });
  it("rejects a missing field, the wrong type, text that is not base64, bytes that are not a PNG, a tiny or an oversized image, and another channel", () => {
    assert.equal(parseUpiQrPay(payAnswer(undefined)), null);
    assert.equal(parseUpiQrPay({ data: {} }), null);
    assert.equal(parseUpiQrPay(null), null);
    assert.equal(parseUpiQrPay(payAnswer(12345)), null);
    assert.equal(parseUpiQrPay(payAnswer("not base64 !!")), null);
    assert.equal(parseUpiQrPay(payAnswer(Buffer.alloc(500, 1).toString("base64"))), null, "right size, wrong magic bytes");
    assert.equal(parseUpiQrPay(payAnswer(dataUrl(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(10)])))), null, "too small");
    assert.equal(parseUpiQrPay(payAnswer(dataUrl(pngBytes(300 * 1024)))), null, "too large");
    assert.equal(parseUpiQrPay(payAnswer(dataUrl(pngBytes()), { channel: "link" })), null);
    assert.equal(parseUpiQrPay(payAnswer("data:image/jpeg;base64,/9j/4AAQ")), null);
  });
  it("does not read the QR from any other place in the answer", () => {
    assert.equal(parseUpiQrPay({ channel: "qrcode", qrcode: dataUrl(pngBytes()), data: { qrcode: dataUrl(pngBytes()) } }), null);
  });
});

describe("Cashfree order requests (fake fetch)", () => {
  const config = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "test-id", CASHFREE_CLIENT_SECRET: "test-secret" });
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/orders")) return new Response(JSON.stringify({ cf_order_id: "9", order_id: "qr_x", order_status: "ACTIVE", payment_session_id: "session_abc", order_amount: 249, order_currency: "INR" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/orders/sessions")) return new Response(JSON.stringify(payAnswer(dataUrl(pngBytes()))), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ cf_order_id: "9", order_id: "qr_x", order_status: "PAID", order_amount: 249, order_currency: "INR" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  it("goes only to the sandbox host and sends the exact amount, currency, idempotency key and Order Pay body", async () => {
    calls.length = 0;
    const client = new CashfreeClient(config, fetchImpl);
    const order = await client.createOrder({ order_id: "qr_x", order_amount: 249, order_currency: "INR", customer_details: { customer_id: "c1", customer_phone: "9876543210" } }, "11111111-1111-5111-a111-111111111111");
    assert.equal(order.paymentSessionId, "session_abc");
    const qr = await client.payUpiQr("session_abc", "22222222-2222-5222-a222-222222222222");
    assert.ok(qr.png.length > 200);
    assert.deepEqual(calls.map((c) => c.url), ["https://sandbox.cashfree.com/pg/orders", "https://sandbox.cashfree.com/pg/orders/sessions"]);
    const create = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual([create.order_amount, create.order_currency], [249, "INR"]);
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { payment_session_id: "session_abc", payment_method: { upi: { channel: "qrcode" } } });
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["x-idempotency-key"], "11111111-1111-5111-a111-111111111111");
    assert.equal(headers["x-api-version"], "2026-01-01");
    assert.ok(!String(calls[0]!.init.body).includes("test-secret"), "the secret is only ever a header");
  });
  it("an Order Pay answer without a usable QR is an error, not a QR", async () => {
    const bad = (async () => new Response(JSON.stringify({ action: "custom", channel: "qrcode", data: { payload: {} } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await assert.rejects(new CashfreeClient(config, bad).payUpiQr("s", "k"), /usable UPI QR/);
  });
  it("an order answer without a payment session is refused", async () => {
    const bad = (async () => new Response(JSON.stringify({ order_id: "qr_x", order_status: "ACTIVE" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await assert.rejects(new CashfreeClient(config, bad).createOrder({ order_id: "qr_x", order_amount: 1, order_currency: "INR", customer_details: { customer_id: "c", customer_phone: "9876543210" } }, "k"), /payment session/);
    assert.equal(parseOrder({ order_id: "a" }), null);
  });
});

describe("sandbox-only gate", () => {
  it("is off by default, allowed in the sandbox when enabled, refused in production unless explicitly allowed", () => {
    assert.match(upiQrBlockReason({ environment: "sandbox" }, {}) ?? "", /not enabled/);
    assert.equal(upiQrBlockReason({ environment: "sandbox" }, { CASHFREE_UPI_QR_ENABLED: "true" }), null);
    assert.match(upiQrBlockReason({ environment: "production" }, { CASHFREE_UPI_QR_ENABLED: "true" }) ?? "", /sandbox only/);
    assert.match(upiQrBlockReason({ environment: "production" }, { CASHFREE_UPI_QR_ENABLED: "true", CASHFREE_UPI_QR_ALLOW_PRODUCTION: "yes" }) ?? "", /sandbox only/, "only the exact word true");
    assert.equal(upiQrBlockReason({ environment: "production" }, { CASHFREE_UPI_QR_ENABLED: "true", CASHFREE_UPI_QR_ALLOW_PRODUCTION: "true" }), null);
  });
});

describe("ids", () => {
  it("the Cashfree order id and idempotency keys are stable per payment, differ per payment and purpose, and are valid", () => {
    const a = "0b7c1f0e-1111-4222-8333-444455556666";
    const b = "0b7c1f0e-1111-4222-8333-444455556667";
    assert.equal(qrOrderIdFor(a), qrOrderIdFor(a));
    assert.notEqual(qrOrderIdFor(a), qrOrderIdFor(b));
    assert.match(qrOrderIdFor(a), /^[A-Za-z0-9_-]{3,45}$/);
    assert.equal(idempotencyKeyFor("create", a), idempotencyKeyFor("create", a));
    assert.notEqual(idempotencyKeyFor("create", a), idempotencyKeyFor("pay", a));
    assert.notEqual(idempotencyKeyFor("create", a), idempotencyKeyFor("create", b));
    assert.match(idempotencyKeyFor("pay", a), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it("a stored QR is read back only when it is complete and still a PNG", () => {
    const good = { upiQr: { directUpi: true, orderId: "qr_a", amount: "249.00", currency: "INR", png: pngBytes().toString("base64"), createdAt: "2026-10-22T00:00:00Z" } };
    assert.equal(readStoredUpiQr(good)?.orderId, "qr_a");
    assert.equal(readStoredUpiQr({ upiQr: { ...good.upiQr, png: Buffer.alloc(300).toString("base64") } }), null);
    assert.equal(readStoredUpiQr({}), null);
    assert.equal(readStoredUpiQr(null), null);
  });
});

describe("verifyQrOrderPaid - only Cashfree's own answer, for the exact amount and currency", () => {
  const order = (over: Record<string, unknown> = {}) => ({ cfOrderId: "9", orderId: "qr_x", orderStatus: "PAID", paymentSessionId: null, orderAmount: "249.00", orderCurrency: "INR", orderExpiryTime: null, ...over });
  const pay = (over: Record<string, unknown> = {}) => ({ cfPaymentId: "p1", paymentStatus: "SUCCESS", paymentAmount: "249.00", bankReference: "UTR1", paymentGroup: "upi", paymentTime: null, ...over });
  const api = (o: ReturnType<typeof order>, payments: ReturnType<typeof pay>[]) => ({ getOrder: async () => o, getOrderPayments: async () => payments });
  const expected = { amount: "249.00", currency: "INR" };

  it("paid for the exact amount with one successful payment", async () => {
    const v = await verifyQrOrderPaid(api(order(), [pay()]), "qr_x", expected);
    assert.deepEqual(v.paid && [v.amount, v.cfPaymentId, v.bankReference], ["249.00", "p1", "UTR1"]);
  });
  it("not paid: order still ACTIVE, another order id, wrong amount, wrong currency, no / failed / several different successful payments, a payment for another amount", async () => {
    const status = async (a: ReturnType<typeof api>) => { const v = await verifyQrOrderPaid(a, "qr_x", expected); return v.paid ? "PAID" : v.status; };
    assert.equal(await status(api(order({ orderStatus: "ACTIVE" }), [])), "ACTIVE");
    assert.equal(await status(api(order({ orderId: "other" }), [pay()])), "ORDER_MISMATCH");
    assert.equal(await status(api(order({ orderAmount: "1.00" }), [pay()])), "AMOUNT_MISMATCH");
    assert.equal(await status(api(order({ orderCurrency: "USD" }), [pay()])), "CURRENCY_MISMATCH");
    assert.equal(await status(api(order(), [])), "NO_SUCCESSFUL_PAYMENT");
    assert.equal(await status(api(order(), [pay({ paymentStatus: "FAILED" })])), "NO_SUCCESSFUL_PAYMENT");
    assert.equal(await status(api(order(), [pay(), pay({ cfPaymentId: "p2" })])), "AMBIGUOUS_PAYMENTS");
    assert.equal(await status(api(order(), [pay({ paymentAmount: "1.00" })])), "AMOUNT_MISMATCH");
    assert.equal(await status(api(order(), [pay(), pay()])), "PAID", "the same payment listed twice is one payment");
  });
  it("reports the amount Cashfree gave so a mismatch can be flagged, and a failed lookup throws (the caller retries)", async () => {
    const v = await verifyQrOrderPaid(api(order({ orderAmount: "1.00" }), []), "qr_x", expected);
    assert.deepEqual(!v.paid && v.reportedAmount, "1.00");
    await assert.rejects(verifyQrOrderPaid({ getOrder: async () => { throw new Error("boom"); } }, "qr_x", expected), /boom/);
  });
});

describe("what a QR encodes (decoded from the picture, not assumed)", () => {
  const qr = (text: string) => QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 400 });
  const expected = { amount: "599.00", currency: "INR" };

  it("a UPI pay request for the exact amount and currency is accepted, and the decoder returns what is written in the picture", async () => {
    const image = await qr("upi://pay?pa=shop@bank&pn=Shop&am=599.00&cu=INR&tn=order1");
    assert.equal(decodeQrPng(image), "upi://pay?pa=shop@bank&pn=Shop&am=599.00&cu=INR&tn=order1");
    assert.deepEqual(assertDirectUpiQr(image, expected), { kind: "upi_pay", amount: "599.00", currency: "INR", hasPayee: true, payee: "shop@bank" });
    assert.equal(assertDirectUpiQr(await qr("upi://pay?pa=shop@bank&am=599&cu=inr"), expected).kind, "upi_pay", "599 = 599.00, currency case-insensitive");
  });
  it("a QR of a web page (checkout / payment link) is refused - it would open a browser", async () => {
    for (const url of ["https://payments.cashfree.com/links/abc123", "http://pay.example.com/x", "https://sandbox.cashfree.com/pg/view/sessions/checkout/web/abc"]) {
      const image = await qr(url);
      assert.throws(() => assertDirectUpiQr(image, expected), /opens a web page/);
    }
  });
  it("another amount, no amount, another currency, no payee, another scheme, and a picture that is not a QR are all refused - with no content in the message", async () => {
    const cases: [string | Buffer, RegExp][] = [
      ["upi://pay?pa=shop@bank&am=1.00&cu=INR", /exact amount/],
      ["upi://pay?pa=shop@bank&cu=INR", /exact amount/],
      ["upi://pay?pa=shop@bank&am=599.00&cu=USD", /currency/],
      ["upi://pay?pa=shop@bank&am=599.00", /currency/],
      ["upi://pay?am=599.00&cu=INR", /no payee/],
      ["tel:+919000000000", /not a UPI payment request/],
      ["just some text", /not a UPI payment request/],
    ];
    for (const [text, rx] of cases) {
      let message = "";
      try { assertDirectUpiQr(await qr(String(text)), expected); } catch (e) { message = (e as Error).message; }
      assert.match(message, rx, String(text));
      assert.ok(!message.includes("shop@bank"), "the payee is never echoed");
    }
    assert.throws(() => assertDirectUpiQr(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(600, 9)]), expected), /could not be read/);
    assert.deepEqual(inspectQrText(null).kind, "unreadable");
  });
});

// ===== MOCKED: the response shape Cashfree SUPPORT supplied (not Cashfree's published reference, not yet seen from the real API). The images are REAL QR codes; the Cashfree answers are hand-made. =====
describe("MOCKED support-supplied Order Pay answer: { action: custom, payment_method: upi, channel: qrcode, data.payload.qrcode: data:image/png;base64,... }", () => {
  const qrPng = (text: string) => QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 400 });
  const upi = "upi://pay?pa=merchant@bank&pn=Shop&am=599.00&cu=INR&tn=order1";
  const supportAnswer = (png: Buffer, over: Record<string, unknown> = {}) => ({ action: "custom", cf_payment_id: "9001", payment_method: "upi", channel: "qrcode", payment_amount: 599, data: { url: null, payload: { qrcode: dataUrl(png) }, content_type: null, method: null }, ...over });
  const expected = { amount: "599.00", currency: "INR" };

  it("parses the supplied example and the image decodes to the direct UPI payment request for the exact amount", async () => {
    const image = await qrPng(upi);
    const parsed = parseUpiQrPay(supportAnswer(image));
    assert.ok(parsed);
    assert.deepEqual([parsed.cfPaymentId, parsed.paymentAmount], ["9001", "599"]);
    assert.equal(assertDirectUpiQr(parsed.png, expected).kind, "upi_pay");
    assert.equal(assertDirectUpiQr(parsed.png, { ...expected, payee: "Merchant@Bank" }).kind, "upi_pay", "the configured merchant UPI id matches (case-insensitive)");
    assert.throws(() => assertDirectUpiQr(parsed.png, { ...expected, payee: "someone-else@bank" }), /different payee/);
  });

  it("end to end through the client with a fake fetch: request body, the answer, then the decode check", async () => {
    const image = await qrPng(upi);
    const config = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "test-id", CASHFREE_CLIENT_SECRET: "test-secret" });
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { sent.push(String(init.body)); return new Response(JSON.stringify(supportAnswer(image)), { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    const qr = await new CashfreeClient(config, fetchImpl).payUpiQr("session_x", "33333333-3333-5333-a333-333333333333");
    assert.deepEqual(JSON.parse(sent[0]!), { payment_session_id: "session_x", payment_method: { upi: { channel: "qrcode" } } });
    assert.equal(assertDirectUpiQr(qr.png, expected).amount, "599.00");
  });

  it("refuses unsupported shapes: a redirect action, another payment method or channel, no qrcode (only data.payload.default / data.url), a URL or other image type in qrcode", async () => {
    const image = await qrPng(upi);
    for (const action of ["link", "post", "form"]) assert.equal(parseUpiQrPay(supportAnswer(image, { action })), null, "action " + action);
    assert.equal(parseUpiQrPay(supportAnswer(image, { payment_method: "card" })), null);
    assert.equal(parseUpiQrPay(supportAnswer(image, { channel: "link" })), null);
    assert.equal(parseUpiQrPay(supportAnswer(image, { data: { url: "https://sandbox.cashfree.com/pg/view/sessions/checkout/web/abc", payload: null } })), null, "a checkout URL is not a QR");
    assert.equal(parseUpiQrPay(supportAnswer(image, { data: { payload: { default: upi } } })), null, "data.payload.default is NOT assumed to be a UPI string");
    assert.equal(parseUpiQrPay(supportAnswer(image, { data: { payload: { qrcode: "https://payments.cashfree.com/links/abc" } } })), null);
    assert.equal(parseUpiQrPay(supportAnswer(image, { data: { payload: { qrcode: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } } })), null);
    assert.equal(parseUpiQrPay(supportAnswer(image, { data: { payload: { qrcode: dataUrl(Buffer.alloc(500, 3)) } } })), null, "a data URI whose bytes are not a PNG");
  });

  it("a well-formed PNG that is NOT a direct UPI request is still refused after decoding: checkout URL, payment-link URL, wrong or missing amount, wrong currency, malformed image", async () => {
    const accepted = async (text: string) => { const p = parseUpiQrPay(supportAnswer(await qrPng(text))); assert.ok(p, "parser accepts any PNG data URI; the decoder decides"); return () => assertDirectUpiQr(p.png, expected); };
    assert.throws(await accepted("https://sandbox.cashfree.com/pg/view/sessions/checkout/web/abc"), /opens a web page/);
    assert.throws(await accepted("https://payments-test.cashfree.com/links/abc123"), /opens a web page/);
    assert.throws(await accepted("upi://pay?pa=merchant@bank&am=1.00&cu=INR"), /exact amount/);
    assert.throws(await accepted("upi://pay?pa=merchant@bank&cu=INR"), /exact amount/);
    assert.throws(await accepted("upi://pay?pa=merchant@bank&am=599.00&cu=USD"), /currency/);
    assert.throws(() => assertDirectUpiQr(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(600, 5)]), expected), /could not be read/);
  });
});
