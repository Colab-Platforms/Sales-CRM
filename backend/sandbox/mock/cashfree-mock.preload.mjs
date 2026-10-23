// SIMULATED Cashfree for local manual testing. Loaded with NODE_OPTIONS=--import <this file> (see start-mock.ps1).
// It replaces global fetch for https://sandbox.cashfree.com/** with an in-process fake - NO network request is made - and refuses any other Cashfree host.
// State is a JSON file (MOCK_CF_STATE) so the server and the harness processes share it. Everything here is SIMULATED: no Cashfree order, QR or payment really exists.
import fs from "node:fs";
import QRCode from "qrcode";

if (process.env.MOCK_NEON_PROXY === "1") {
  // the app talks to Postgres through the Neon websocket driver; the local isolated database sits behind a websocket proxy on 5545
  const { neonConfig } = await import("@neondatabase/serverless");
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
  neonConfig.wsProxy = () => "127.0.0.1:5545/v1";
}

const STATE = process.env.MOCK_CF_STATE;
if (!STATE) throw new Error("MOCK_CF_STATE is not set");
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { orders: {}, links: {}, control: {}, log: [], n: 0 };
  }
};
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!/(^|\.)cashfree\.com$/i.test(url.hostname)) return realFetch(input, init);
  if (url.hostname !== "sandbox.cashfree.com") throw new Error(`MOCK GUARD: a non-sandbox Cashfree host was requested (${url.hostname}); blocked`);
  const method = (init.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^\/pg/, "");
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const s = load();
  s.log.push(`${method} ${path}`);
  const reply = (status, payload) => { save(s); return json(status, payload); };
  const c = s.control;
  let m;

  if (method === "POST" && path === "/links") {
    s.n += 1;
    s.links[body.link_id] = { status: "ACTIVE", amount: body.link_amount };
    return reply(200, { cf_link_id: `mock-link-${s.n}`, link_id: body.link_id, link_status: "ACTIVE", link_url: `https://payments-test.cashfree.com/links/${String(body.link_id).slice(-16)}`, link_amount: body.link_amount, link_amount_paid: 0, link_expiry_time: body.link_expiry_time });
  }
  if ((m = /^\/links\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
    const l = s.links[m[1]] ?? (s.links[m[1]] = { status: "ACTIVE", amount: 0 });
    l.status = "CANCELLED";
    return reply(200, { link_id: m[1], link_status: "CANCELLED", link_amount: l.amount, link_amount_paid: 0 });
  }
  if ((m = /^\/links\/([^/]+)\/orders$/.exec(path)) && method === "GET") {
    const p = c.linkPaid;
    return reply(200, p && p.linkId === m[1] ? [{ order_id: p.orderId, cf_order_id: "mock-link-order", order_status: "PAID", order_amount: p.amount, link_id: m[1] }] : []);
  }
  if ((m = /^\/links\/([^/]+)$/.exec(path)) && method === "GET") {
    const l = s.links[m[1]] ?? { status: "ACTIVE", amount: 0 };
    const paid = c.linkPaid && c.linkPaid.linkId === m[1];
    return reply(200, { link_id: m[1], link_status: paid ? "PAID" : l.status, link_amount: l.amount, link_amount_paid: paid ? c.linkPaid.amount : 0 });
  }
  if (method === "POST" && path === "/orders") {
    s.n += 1;
    s.orders[body.order_id] = { cf_order_id: `mock-order-${s.n}`, order_id: body.order_id, order_status: "ACTIVE", payment_session_id: `mock_session_${s.n}`, order_amount: body.order_amount, order_currency: body.order_currency, order_expiry_time: body.order_expiry_time };
    return reply(200, s.orders[body.order_id]);
  }
  if (method === "POST" && path === "/orders/sessions") {
    const order = Object.values(s.orders).find((o) => o.payment_session_id === body.payment_session_id);
    if (!order) return reply(400, { message: "mock: unknown payment session", code: "order_not_found", type: "invalid_request_error" });
    const upi = `upi://pay?pa=simulated@mock&pn=SIMULATED%20NOT%20A%20REAL%20QR&am=${order.order_amount}&cu=${order.order_currency}&tn=${order.order_id}`;
    const qrcode = await QRCode.toDataURL(upi, { errorCorrectionLevel: "M", margin: 2, width: 512 });
    return reply(200, { action: "custom", cf_payment_id: `mock-pay-${order.order_id.slice(-6)}`, channel: "qrcode", payment_method: "upi", payment_amount: order.order_amount, data: { url: null, payload: { qrcode }, content_type: null, method: null } });
  }
  if ((m = /^\/orders\/([^/]+)\/payments$/.exec(path)) && method === "GET") {
    const p = [c.qrPaid, c.linkPaid].find((x) => x && x.orderId === m[1]);
    return reply(200, p ? [{ cf_payment_id: p.cfPaymentId, payment_status: "SUCCESS", payment_amount: p.amount, bank_reference: "SIMULATED-UTR", payment_group: "upi", payment_time: new Date().toISOString() }] : []);
  }
  if ((m = /^\/orders\/([^/]+)$/.exec(path)) && method === "GET") {
    const o = s.orders[m[1]];
    if (!o) return reply(404, { message: "mock: order does not exist", code: "order_not_found", type: "invalid_request_error" });
    const paid = c.qrPaid && c.qrPaid.orderId === m[1];
    return reply(200, { ...o, order_status: paid ? "PAID" : o.order_status });
  }
  if ((m = /^\/orders\/([^/]+)$/.exec(path)) && method === "PATCH") {
    const o = s.orders[m[1]];
    if (!o) return reply(404, { message: "mock: order does not exist", code: "order_not_found", type: "invalid_request_error" });
    o.order_status = body.order_status;
    return reply(200, o);
  }
  save(s);
  throw new Error(`MOCK GUARD: unexpected Cashfree request ${method} ${path}; blocked (nothing was sent)`);
};
console.log("[mock-cashfree] fetch to sandbox.cashfree.com is SIMULATED in this process; no network request will be made to Cashfree");
