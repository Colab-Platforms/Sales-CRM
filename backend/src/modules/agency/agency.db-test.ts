// Run against the ISOLATED test database only (never .env): run-iso.ps1 --test src/modules/agency/agency.db-test.ts
// The agency API with its REAL storage (Prisma) and the REAL WhatsAppMessagingService, over HTTP. Only Meta is faked (the messaging service's own getMeta hook, as the other messaging tests do).
// Everything it creates carries a unique tag and is removed afterwards.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../../lib/prisma.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import { WhatsAppSendError, type WhatsAppProvider } from "../whatsapp/whatsapp.provider.js";
import { generateApiKey } from "./agency.keys.js";
import { PrismaAgencyRepo } from "./agency.repo.js";
import { agencyJsonErrorHandler, createAgencyRouter } from "./agency.routes.js";

const tag = randomUUID().slice(0, 8);
const LINK = `https://payments.cashfree.com/links/${tag}`;
const phone = (n: number) => `+9198${tag.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}${String(1000 + n)}`.slice(0, 13);

const sent: { to: string; templateName: string; params: string[]; paramNames?: string[]; languageCode?: string }[] = [];
let mode: "ok" | "fail" = "ok";
const fakeMeta: WhatsAppProvider = {
  id: "META",
  sendTemplateMessage: async (input: Parameters<WhatsAppProvider["sendTemplateMessage"]>[0]) => {
    sent.push({ to: input.to, templateName: input.templateName, params: input.params, paramNames: input.paramNames, languageCode: input.languageCode });
    if (mode === "fail") throw new WhatsAppSendError("Meta Cloud API rejected the template message (HTTP 400): (#132001) Template name does not exist in the translation", { error: { code: 132001 } });
    return { providerMessageId: `wamid.${randomUUID()}`, raw: { ok: true } };
  },
  verifyWebhook: () => true,
  parseIncomingWebhook: () => [],
} as unknown as WhatsAppProvider;

let server: Server;
let url = "";
let key = "";
let keyId = "";
let templateId = "";

before(async () => {
  const k = generateApiKey();
  key = k.key;
  keyId = (await prisma.agencyApiKey.create({ data: { name: `test-${tag}`, keyPrefix: k.prefix, keyHash: k.hash, rateLimitPerMinute: 200 }, select: { id: true } })).id;
  templateId = (await prisma.whatsAppTemplate.create({ data: { name: `agency_pay_${tag}`, provider: "META", language: "en", body: "Hi {{customer_name}}, please pay here: {{payment_link}}", variables: ["customer_name", "payment_link"], status: "APPROVED", providerTemplateId: `meta-${tag}` }, select: { id: true } })).id;
  const app = express();
  app.use("/api/agency", express.json({ limit: "32kb" }), createAgencyRouter({ repo: new PrismaAgencyRepo(), messaging: new WhatsAppMessagingService(prisma, undefined, async () => fakeMeta), env: { AGENCY_PAYMENT_LINK_TEMPLATE: `agency_pay_${tag}` } }), agencyJsonErrorHandler);
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agency/whatsapp/payment-link`;
});

after(async () => {
  await new Promise((r) => server.close(() => r(null)));
  const leads = await prisma.lead.findMany({ where: { requirement: { contains: "AI calling agency" }, normalizedMobile: { startsWith: "+9198" }, mobile: { contains: tag.replace(/\D/g, "").padEnd(4, "7").slice(0, 4) } }, select: { id: true } });
  const leadIds = leads.map((l) => l.id);
  await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.whatsAppMessage.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.communicationPreference.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.agencyMessageRequest.deleteMany({ where: { apiKeyId: keyId } });
  await prisma.agencyApiKey.delete({ where: { id: keyId } });
  await prisma.whatsAppTemplate.delete({ where: { id: templateId } });
  await prisma.$disconnect();
});

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const body = (n: number, over: Record<string, unknown> = {}) => ({ customerName: "Test Customer", mobile: phone(n), paymentLink: `${LINK}-${n}`, customerConsent: true, ...over });

describe("agency payment-link API with the real storage and messaging service", () => {
  it("sends the approved Meta template with named parameters, records the message, the consent and the request log", async () => {
    sent.length = 0;
    const r = await post(body(1), { "idempotency-key": `db-${tag}-0001` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message.template, `agency_pay_${tag}`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.templateName, `agency_pay_${tag}`, "Meta is addressed by the template NAME");
    assert.deepEqual(sent[0]!.paramNames, ["customer_name", "payment_link"]);
    assert.deepEqual(sent[0]!.params, ["Test Customer", `${LINK}-1`]);
    assert.equal(sent[0]!.languageCode, "en");

    const log = await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: r.json.requestId } });
    assert.equal(log.status, "SENT");
    assert.equal(log.providerMessageId, r.json.message.whatsappMessageId);
    assert.equal(log.linkHost, "payments.cashfree.com");
    assert.ok(!log.toMasked.includes(phone(1).slice(4, 9)), "the number is masked in the log");
    const message = await prisma.whatsAppMessage.findFirstOrThrow({ where: { providerMessageId: log.providerMessageId! }, select: { status: true, direction: true, body: true, sentById: true, leadId: true } });
    assert.equal(message.status, "SENT");
    assert.match(message.body ?? "", new RegExp(`${LINK}-1`));
    assert.equal(message.sentById, null, "not attributed to any CRM user");
    const pref = await prisma.communicationPreference.findUniqueOrThrow({ where: { leadId_channel: { leadId: message.leadId!, channel: "WHATSAPP" } }, select: { status: true, source: true } });
    assert.deepEqual(pref, { status: "OPTED_IN", source: "AI_CALLING_AGENCY" });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: message.leadId! }, select: { firstName: true, lastName: true, normalizedMobile: true } });
    assert.equal(lead.firstName, "Test");
    assert.equal(lead.normalizedMobile, phone(1));
  });

  it("the same Idempotency-Key does not send twice (database unique key), a different request on that key is refused", async () => {
    sent.length = 0;
    const a = await post(body(2), { "idempotency-key": `db-${tag}-0002` });
    const burst = await Promise.all(Array.from({ length: 6 }, () => post(body(2), { "idempotency-key": `db-${tag}-0002` })));
    assert.equal(a.status, 200);
    assert.equal(sent.length, 1);
    assert.ok(burst.every((x) => (x.status === 200 && x.json.duplicate === true) || (x.status === 409 && x.json.error.code === "REQUEST_IN_PROGRESS")));
    const other = await post(body(2, { paymentLink: `${LINK}-other` }), { "idempotency-key": `db-${tag}-0002` });
    assert.equal(other.status, 409);
    assert.equal(await prisma.agencyMessageRequest.count({ where: { apiKeyId: keyId, idempotencyKey: `db-${tag}-0002` } }), 1);
  });

  it("concurrent identical requests without a key: one message", async () => {
    sent.length = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => post(body(3))));
    assert.ok(results.every((x) => x.status === 200 || x.status === 409));
    assert.equal(sent.length, 1);
    assert.equal(await prisma.agencyMessageRequest.count({ where: { apiKeyId: keyId, toMasked: { contains: "1003" }, status: "SENT" } }), 1, "one request row, not one per call");
  });

  it("a Meta refusal is a 502, is logged FAILED with the message row FAILED, and the same key can be retried", async () => {
    sent.length = 0;
    mode = "fail";
    const failed = await post(body(4), { "idempotency-key": `db-${tag}-0004` });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error.code, "TEMPLATE_REJECTED");
    const row = await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: failed.json.requestId } });
    assert.equal(row.status, "FAILED");
    assert.equal(row.errorCode, "TEMPLATE_REJECTED");
    assert.match(row.errorMessage ?? "", /132001/);
    const msg = await prisma.whatsAppMessage.findFirst({ where: { toNumber: phone(4) }, select: { status: true, errorMessage: true } });
    assert.equal(msg?.status, "FAILED");
    mode = "ok";
    const retry = await post(body(4), { "idempotency-key": `db-${tag}-0004` });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.requestId, failed.json.requestId);
  });

  it("an opted-out customer is never messaged; consent is not overwritten", async () => {
    sent.length = 0;
    const first = await post(body(5));
    assert.equal(first.status, 200);
    const leadId = (await prisma.lead.findFirstOrThrow({ where: { normalizedMobile: phone(5) }, select: { id: true } })).id;
    await prisma.communicationPreference.update({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, data: { status: "OPTED_OUT" } });
    sent.length = 0;
    const r = await post(body(5, { paymentLink: `${LINK}-5b` }));
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, "CUSTOMER_OPTED_OUT");
    assert.equal(sent.length, 0);
    assert.equal((await prisma.communicationPreference.findUniqueOrThrow({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, select: { status: true } })).status, "OPTED_OUT");
  });

  it("an existing customer is reused (no second lead), and the per-hour cap counts across requests", async () => {
    sent.length = 0;
    assert.equal((await post(body(6, { paymentLink: `${LINK}-6-0` }))).status, 200);
    // a second DIFFERENT link inside the send path's 30 s guard is held back (retryable), never reported as sent
    const tooSoon = await post(body(6, { paymentLink: `${LINK}-6-1` }));
    assert.equal(tooSoon.status, 409);
    assert.equal(tooSoon.json.error.code, "RECENT_MESSAGE_CONFLICT");
    // two more earlier sends within the hour (as if sent minutes ago): the per-hour cap of 3 is now reached
    const leadId = (await prisma.lead.findFirstOrThrow({ where: { normalizedMobile: phone(6) }, select: { id: true } })).id;
    const earlier = new Date(Date.now() - 10 * 60_000);
    await prisma.agencyMessageRequest.createMany({ data: [1, 2].map((i) => ({ apiKeyId: keyId, idempotencyKey: `seed-${tag}-${i}`, requestHash: "seed", status: "SENT", customerName: "x", toMasked: "-", linkHost: "-", leadId, createdAt: earlier })) });
    const blocked = await post(body(6, { paymentLink: `${LINK}-6-x` }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "RECIPIENT_LIMIT");
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(6) } }), 1);
    assert.equal(sent.length, 1);
  });

  it("an order of the same customer is linked to the message; an order of another number is refused", async () => {
    const mine = await prisma.lead.create({ data: { leadNumber: `L-${randomUUID()}`, firstName: "Order", mobile: phone(7), normalizedMobile: phone(7), requirement: "AI calling agency test" }, select: { id: true } });
    const other = await prisma.lead.create({ data: { leadNumber: `L-${randomUUID()}`, firstName: "Other", mobile: phone(8), normalizedMobile: phone(8), requirement: "AI calling agency test" }, select: { id: true } });
    const mk = (leadId: string, n: string) => prisma.order.create({ data: { orderNumber: `AGY-${tag}-${n}`, leadId, status: "CONFIRMED", source: "SALESPERSON", currency: "INR", totalAmount: "449.00", subtotal: "449.00" } as never, select: { id: true } });
    const o1 = await mk(mine.id, "A");
    await mk(other.id, "B");
    try {
      const ok = await post(body(7, { orderId: `AGY-${tag}-A` }));
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      const log = await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: ok.json.requestId } });
      assert.equal(log.orderId, o1.id);
      assert.equal(log.leadId, mine.id);
      const wrong = await post(body(7, { orderId: `AGY-${tag}-B`, paymentLink: `${LINK}-7b` }));
      assert.equal(wrong.status, 422);
      assert.equal(wrong.json.error.code, "ORDER_MOBILE_MISMATCH");
    } finally {
      await prisma.activity.deleteMany({ where: { leadId: { in: [mine.id, other.id] } } });
      await prisma.whatsAppMessage.deleteMany({ where: { leadId: { in: [mine.id, other.id] } } });
      await prisma.communicationPreference.deleteMany({ where: { leadId: { in: [mine.id, other.id] } } });
      await prisma.order.deleteMany({ where: { orderNumber: { startsWith: `AGY-${tag}-` } } });
      await prisma.lead.deleteMany({ where: { id: { in: [mine.id, other.id] } } });
    }
  });

  it("unauthorized and invalid requests change nothing", async () => {
    const before = await prisma.whatsAppMessage.count({ where: { templateName: `agency_pay_${tag}` } });
    const noKey = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(9)) });
    assert.equal(noKey.status, 401);
    const bad = await post(body(9, { mobile: "9876543210", paymentLink: "http://x" }));
    assert.equal(bad.status, 400);
    assert.equal(await prisma.whatsAppMessage.count({ where: { templateName: `agency_pay_${tag}` } }), before);
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(9) } }), 0, "no customer is created for a rejected request");
    assert.equal((await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: bad.json.requestId } })).status, "REJECTED");
  });
});
