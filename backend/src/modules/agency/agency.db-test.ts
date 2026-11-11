// Run against the ISOLATED test database only (never .env): run-iso.ps1 --test src/modules/agency/agency.db-test.ts
// The agency API (request: customerName + mobile ONLY) with its REAL storage (Prisma), the REAL order-eligibility query and the REAL WhatsAppMessagingService, over HTTP. Faked: Meta (the messaging service's
// own getMeta hook, as the other messaging tests do) and the payment-link maker (no real Cashfree payment link is ever created). Everything created carries a unique tag and is removed afterwards.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { ProductType } from "../../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/apiError.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import { WhatsAppSendError, type WhatsAppProvider } from "../whatsapp/whatsapp.provider.js";
import { generateApiKey } from "./agency.keys.js";
import { PrismaAgencyRepo } from "./agency.repo.js";
import { agencyJsonErrorHandler, createAgencyRouter } from "./agency.routes.js";
import type { PaymentLinkMaker } from "./agency.payment-link.service.js";
import { CashfreeLinkMaker } from "./agency.cashfree-links.js";
import CashfreePaymentsService from "../cashfree/cashfree.payments.service.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";

const tag = randomUUID().slice(0, 8);
const digits = tag.replace(/\D/g, "").padEnd(4, "7").slice(0, 4);
const phone = (n: number) => `+9198${digits}${String(1000 + n)}`.slice(0, 13);

const sent: { to: string; templateName: string; params: string[]; paramNames?: string[] }[] = [];
let mode: "ok" | "fail" = "ok";
const fakeMeta: WhatsAppProvider = {
  id: "META",
  sendTemplateMessage: async (input: Parameters<WhatsAppProvider["sendTemplateMessage"]>[0]) => {
    sent.push({ to: input.to, templateName: input.templateName, params: input.params, paramNames: input.paramNames });
    if (mode === "fail") throw new WhatsAppSendError("Meta Cloud API rejected the template message (HTTP 400): (#132001) Template name does not exist in the translation", { error: { code: 132001 } });
    return { providerMessageId: `wamid.${randomUUID()}`, raw: { ok: true } };
  },
  verifyWebhook: () => true,
  parseIncomingWebhook: () => [],
} as unknown as WhatsAppProvider;

const linkCalls: string[] = [];
let linkFails = false;
const fakeLinks: PaymentLinkMaker = {
  createLink: async (orderId) => {
    linkCalls.push(orderId);
    if (linkFails) throw new ApiError("This order has no pending amount to collect", 400);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalAmount: true } });
    return { paymentUrl: `https://payments.cashfree.com/links/${tag}-${orderId.slice(0, 8)}`, amount: Number(o.totalAmount.toString()).toFixed(2), reused: false, expiresAt: null };
  },
};

let server: Server;
let url = "";
let key = "";
let keyId = "";
let templateId = "";
let productId = "";
const leadIds: string[] = [];
const orderIds: string[] = [];

async function lead(n: number, name = "Test Customer") {
  const l = await prisma.lead.create({ data: { leadNumber: `L-${tag}-${n}-${randomUUID().slice(0, 4)}`, firstName: name, mobile: phone(n), normalizedMobile: phone(n), requirement: `agency-test ${tag}` }, select: { id: true } });
  leadIds.push(l.id);
  return l.id;
}
async function order(leadId: string, o: { status?: "CONFIRMED" | "PROCESSING" | "CANCELLED" | "SHIPPED" | "DELIVERED" | "PENDING_PAYMENT"; mode?: "COD" | "PREPAID"; payment?: "PENDING" | "SUCCESS" | "none"; total?: string; shopify?: string | null } = {}) {
  const total = o.total ?? "449.00";
  const row = await prisma.order.create({
    data: {
      orderNumber: `CRM-${tag}-${randomUUID().slice(0, 6)}`, leadId, status: o.status ?? "CONFIRMED", source: "SALESPERSON", currency: "INR", subtotal: total, totalAmount: total,
      ...(o.shopify ? { externalSource: "SHOPIFY" as const, externalId: `${Date.now()}${Math.floor(Math.random() * 1e6)}`, externalNumber: o.shopify } : {}),
      metadata: { paymentMode: o.mode ?? "COD" },
      items: { create: [{ productNameSnapshot: "P", quantity: 1, unitPrice: total, totalPrice: total, productId }] },
      ...(o.payment === "none" ? {} : { payments: { create: [{ amount: total, currency: "INR", method: (o.mode ?? "COD") === "COD" ? "COD" as const : "PAYMENT_LINK" as const, status: (o.payment ?? "PENDING") as "PENDING" | "SUCCESS" }] } }),
    },
    select: { id: true, orderNumber: true },
  });
  orderIds.push(row.id);
  return row;
}

before(async () => {
  try {
  const k = generateApiKey();
  key = k.key;
  keyId = (await prisma.agencyApiKey.create({ data: { name: `test-${tag}`, keyPrefix: k.prefix, keyHash: k.hash, rateLimitPerMinute: 200 }, select: { id: true } })).id;
  templateId = (await prisma.whatsAppTemplate.create({ data: { name: `agency_pay_${tag}`, provider: "META", language: "en", body: "Hi {{customer_name}}, please pay here: {{payment_link}}", variables: ["customer_name", "payment_link"], status: "APPROVED", providerTemplateId: `meta-${tag}` }, select: { id: true } })).id;
  productId = (await prisma.product.create({ data: { name: "P", type: ProductType.PRODUCT, sku: `SKU-${tag}`, basePrice: "449.00" }, select: { id: true } })).id;
  const app = express();
  app.use("/api/agency", express.json({ limit: "32kb" }), createAgencyRouter({ repo: new PrismaAgencyRepo(), messaging: new WhatsAppMessagingService(prisma, undefined, async () => fakeMeta), links: fakeLinks, env: { AGENCY_PAYMENT_LINK_TEMPLATE: `agency_pay_${tag}` } }), agencyJsonErrorHandler);
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agency/whatsapp/payment-link`;
  } catch (error) {
    console.error("SETUP FAILED:", error instanceof Error ? error.message.slice(0, 600) : error);
    throw error;
  }
});

after(async () => {
  await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
  await prisma.activity.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { orderId: { in: orderIds } }] } });
  await prisma.whatsAppMessage.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.communicationPreference.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.agencyMessageRequest.deleteMany({ where: { apiKeyId: keyId } });
  await prisma.agencyApiKey.delete({ where: { id: keyId } });
  await prisma.whatsAppTemplate.delete({ where: { id: templateId } });
  await prisma.product.delete({ where: { id: productId } });
  await prisma.$disconnect();
});

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const body = (n: number, over: Record<string, unknown> = {}) => ({ customerName: "Test Customer", mobile: phone(n), ...over });

describe("agency payment-link API: real storage, real order lookup, real messaging service (fake Meta, fake payment gateway)", () => {
  it("finds the ONE eligible COD order among cancelled, shipped, prepaid, already-paid and another customer's orders; links it; sends the approved template with the CRM-created link", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(1);
    const eligible = await order(l, { shopify: "#AWL999001", total: "449.00" });
    await order(l, { status: "CANCELLED" });
    await order(l, { status: "SHIPPED" });
    await order(l, { status: "DELIVERED" });
    await order(l, { mode: "PREPAID", status: "PENDING_PAYMENT", payment: "PENDING" });
    await order(l, { payment: "SUCCESS" });
    const other = await lead(90);
    await order(other);

    const r = await post(body(1), { "idempotency-key": `db-${tag}-0001` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(linkCalls, [eligible.id], "the payment link was requested for the eligible order only");
    assert.deepEqual(r.json.order, { orderNumber: eligible.orderNumber, shopifyOrderNumber: "#AWL999001" });
    assert.equal(r.json.payment.amount, "449.00");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.templateName, `agency_pay_${tag}`);
    assert.deepEqual(sent[0]!.paramNames, ["customer_name", "payment_link"]);
    assert.equal(sent[0]!.params[0], "Test Customer");
    assert.match(sent[0]!.params[1]!, new RegExp(`payments.cashfree.com/links/${tag}-${eligible.id.slice(0, 8)}`));

    const log = await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: r.json.requestId } });
    assert.deepEqual([log.status, log.orderId, log.leadId], ["SENT", eligible.id, l]);
    assert.ok(!log.toMasked.includes(phone(1).slice(4, 9)), "the number is masked in the log");
    const message = await prisma.whatsAppMessage.findFirstOrThrow({ where: { providerMessageId: log.providerMessageId! }, select: { status: true, sentById: true, leadId: true } });
    assert.deepEqual([message.status, message.sentById, message.leadId], ["SENT", null, l]);
  });

  it("several eligible COD orders: 409 with the candidates, no link, no message; none eligible or unknown customer: 404", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(2);
    const a = await order(l, { total: "449.00", shopify: "#AWL999002" });
    const b = await order(l, { status: "PROCESSING", total: "999.00" });
    const many = await post(body(2));
    assert.equal(many.status, 409);
    assert.equal(many.json.error.code, "MULTIPLE_ELIGIBLE_ORDERS");
    assert.deepEqual(many.json.error.details.orders.map((o: any) => o.orderNumber).sort(), [a.orderNumber, b.orderNumber].sort());

    const none = await lead(3);
    await order(none, { status: "CANCELLED" });
    const noOrder = await post(body(3));
    assert.deepEqual([noOrder.status, noOrder.json.error.code], [404, "NO_ELIGIBLE_ORDER"]);
    const unknown = await post(body(4));
    assert.deepEqual([unknown.status, unknown.json.error.code], [404, "CUSTOMER_NOT_FOUND"]);
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(4) } }), 0, "an unknown number does not create a customer");
    assert.equal(linkCalls.length + sent.length, 0);
  });

  it("two customer records with the same mobile: their eligible orders are considered together (never guessed)", async () => {
    linkCalls.length = 0;
    const l1 = await lead(5);
    await prisma.lead.create({ data: { leadNumber: `L-${tag}-5b`, firstName: "Dup", mobile: phone(5), normalizedMobile: phone(5), requirement: `agency-test ${tag}` } }).then((x) => leadIds.push(x.id));
    const l2 = leadIds.at(-1)!;
    await order(l1);
    await order(l2);
    const r = await post(body(5));
    assert.equal(r.status, 409);
    assert.equal(linkCalls.length, 0);
  });

  it("an opted-out customer is never messaged and no link is created; consent is not overwritten", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(6);
    await order(l);
    await prisma.communicationPreference.create({ data: { leadId: l, channel: "WHATSAPP", status: "OPTED_OUT", source: "TEST" } });
    const r = await post(body(6));
    assert.deepEqual([r.status, r.json.error.code], [422, "CUSTOMER_OPTED_OUT"]);
    assert.equal(linkCalls.length + sent.length, 0);
    assert.equal((await prisma.communicationPreference.findUniqueOrThrow({ where: { leadId_channel: { leadId: l, channel: "WHATSAPP" } } })).status, "OPTED_OUT");
  });

  it("payment-link refusal and a Meta refusal are clear failures logged FAILED; the same key can be retried and then succeeds", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(7);
    const o = await order(l);
    linkFails = true;
    const noLink = await post(body(7), { "idempotency-key": `db-${tag}-0007` });
    assert.deepEqual([noLink.status, noLink.json.error.code], [422, "ORDER_NOT_PAYABLE"]);
    assert.equal(sent.length, 0, "no message without a link");
    linkFails = false;

    mode = "fail";
    const failed = await post(body(7), { "idempotency-key": `db-${tag}-0007` });
    assert.deepEqual([failed.status, failed.json.error.code], [502, "TEMPLATE_REJECTED"]);
    const row = await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: failed.json.requestId } });
    assert.deepEqual([row.status, row.errorCode, row.orderId], ["FAILED", "TEMPLATE_REJECTED", o.id]);
    assert.equal((await prisma.whatsAppMessage.findFirst({ where: { toNumber: phone(7) }, select: { status: true } }))?.status, "FAILED");
    mode = "ok";
    const retry = await post(body(7), { "idempotency-key": `db-${tag}-0007` });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.requestId, failed.json.requestId);
  });

  it("the same Idempotency-Key never sends or creates a link twice (database unique key), and concurrent identical requests without a key send one message", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(8);
    await order(l);
    const key1 = { "idempotency-key": `db-${tag}-0008` };
    const a = await post(body(8), key1);
    const burst = await Promise.all(Array.from({ length: 6 }, () => post(body(8), key1)));
    assert.equal(a.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(linkCalls.length, 1);
    assert.ok(burst.every((x) => (x.status === 200 && x.json.duplicate === true) || (x.status === 409 && x.json.error.code === "REQUEST_IN_PROGRESS")));
    assert.equal(await prisma.agencyMessageRequest.count({ where: { apiKeyId: keyId, idempotencyKey: `db-${tag}-0008` } }), 1);

    sent.length = 0; linkCalls.length = 0;
    const l2 = await lead(9);
    await order(l2);
    const results = await Promise.all(Array.from({ length: 5 }, () => post(body(9))));
    assert.ok(results.every((x) => x.status === 200 || x.status === 409));
    assert.equal(sent.length, 1);
    assert.equal(linkCalls.length, 1);
  });

  it("unauthorized and invalid requests change nothing; the old three-field payload is refused", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(10);
    await order(l);
    const before = await prisma.agencyMessageRequest.count({ where: { apiKeyId: keyId } });
    const noKey = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(10)) });
    assert.equal(noKey.status, 401);
    const old = await post(body(10, { paymentLink: "https://payments.cashfree.com/links/x", orderId: "X", customerConsent: true }));
    assert.equal(old.status, 400);
    assert.equal((await post(body(10, { mobile: "12345" }))).status, 400);
    assert.equal(linkCalls.length + sent.length, 0);
    assert.equal(await prisma.agencyMessageRequest.count({ where: { apiKeyId: keyId, status: { not: "REJECTED" } } }), before, "only rejected rows were added");
  });
});

describe("with the REAL CRM payment-link service (Cashfree itself faked, no network)", () => {
  it("creates a real pending payment-link payment for the order outstanding amount (once, reused on repeat), acting as the configured CRM user, and sends the gateway link", async () => {
    const admin = await prisma.user.create({ data: { name: "Agency actor", username: `agency-actor-${tag}`, role: "ADMIN" }, select: { id: true } });
    const gatewayCalls: { link_id: string; link_amount: number }[] = [];
    const cfg = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });
    const api = {
      createLink: async (request: { link_id: string; link_amount: number }) => { gatewayCalls.push(request); return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${request.link_id}`, linkAmount: String(request.link_amount), linkAmountPaid: "0", linkExpiryTime: null }; },
      getLink: async () => { throw new Error("not used"); }, cancelLink: async () => { throw new Error("not used"); },
    };
    const maker = new CashfreeLinkMaker(new CashfreePaymentsService(prisma, { config: () => cfg, client: () => api as never }), { AGENCY_ACTOR_USER_ID: admin.id });
    const app = express();
    app.use("/api/agency", express.json(), createAgencyRouter({ repo: new PrismaAgencyRepo(), messaging: new WhatsAppMessagingService(prisma, undefined, async () => fakeMeta), links: maker, env: { AGENCY_PAYMENT_LINK_TEMPLATE: `agency_pay_${tag}` } }), agencyJsonErrorHandler);
    const srv: Server = await new Promise((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
    const realUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/agency/whatsapp/payment-link`;
    try {
      sent.length = 0;
      const l = await lead(20);
      const o = await order(l, { shopify: "#AWL999020", total: "549.00" });
      const call = (headers: Record<string, string> = {}) => fetch(realUrl, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: JSON.stringify(body(20)) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
      const first = await call({ "idempotency-key": `db-${tag}-0020` });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      assert.equal(first.json.payment.amount, "549.00");
      assert.equal(gatewayCalls.length, 1);
      assert.equal(gatewayCalls[0]!.link_amount, 549);
      const payments = await prisma.payment.findMany({ where: { orderId: o.id, externalSource: "CASHFREE" }, select: { status: true, method: true, amount: true, paymentUrl: true } });
      assert.equal(payments.length, 1);
      assert.deepEqual([payments[0]!.status, payments[0]!.method, payments[0]!.amount.toString()], ["PENDING", "PAYMENT_LINK", "549"]);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!.params[1]!, /^https:\/\/pay\.test\/.+/, "the link the gateway returned is the one sent");
      // the customer is called again later (a new request): the same open link is reused, not a second one
      sent.length = 0;
      await prisma.agencyMessageRequest.updateMany({ where: { apiKeyId: keyId, leadId: l }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      await prisma.whatsAppMessage.deleteMany({ where: { leadId: l } });
      const again = await call({ "idempotency-key": `db-${tag}-0021` });
      assert.equal(again.status, 200, JSON.stringify(again.json));
      assert.equal(again.json.payment.reusedExistingLink, true);
      assert.equal(gatewayCalls.length, 1, "no second payment link at the gateway");
      assert.equal(await prisma.payment.count({ where: { orderId: o.id, externalSource: "CASHFREE" } }), 1);
    } finally {
      await new Promise((r) => srv.close(() => r(null)));
      await prisma.activity.deleteMany({ where: { actorId: admin.id } });
      await prisma.user.delete({ where: { id: admin.id } }).catch(() => undefined);
    }
  });
});
