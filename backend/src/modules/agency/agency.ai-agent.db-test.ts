// Run against the ISOLATED test database only (never .env): run-iso.ps1 --test src/modules/agency/agency.ai-agent.db-test.ts
// AI Agent activity tracking with REAL storage: the agency API (fake Meta, fake payment-link maker - no real link, no real message) records one activity per valid authenticated request; the lead gets an
// "AI Agent" tag and shows the activity in its timeline; the lead list / timeline can filter it; no lead is created for a number that already has one; and nothing marks a lead as called / contacted.
// Everything created carries a unique tag and is removed afterwards.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { ProductType } from "../../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import type { WhatsAppProvider } from "../whatsapp/whatsapp.provider.js";
import CustomersService from "../customers/customers.service.js";
import LeadService from "../lead/lead.service.js";
import { generateApiKey } from "./agency.keys.js";
import { PrismaAgencyRepo } from "./agency.repo.js";
import { agencyJsonErrorHandler, createAgencyRouter } from "./agency.routes.js";
import type { PaymentLinkMaker } from "./agency.payment-link.service.js";

const tag = randomUUID().slice(0, 8);
const digits = tag.replace(/\D/g, "").padEnd(4, "7").slice(0, 4);
const phone = (n: number) => `+9197${digits}${String(2000 + n)}`.slice(0, 13);

const sent: string[] = [];
const fakeMeta = {
  id: "META",
  sendTemplateMessage: async (input: { to: string }) => { sent.push(input.to); return { providerMessageId: `wamid.${randomUUID()}`, raw: { ok: true } }; },
  verifyWebhook: () => true,
  parseIncomingWebhook: () => [],
} as unknown as WhatsAppProvider;
const linkCalls: string[] = [];
const fakeLinks: PaymentLinkMaker = {
  createLink: async (orderId) => {
    linkCalls.push(orderId);
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
let salesId = "";
const leadIds: string[] = [];
const orderIds: string[] = [];
const requestIds: string[] = [];

async function lead(n: number, extra: { ownerId?: string; name?: string } = {}) {
  const l = await prisma.lead.create({
    data: { leadNumber: `L-${tag}-${n}-${randomUUID().slice(0, 4)}`, firstName: extra.name ?? "Test Customer", mobile: phone(n), normalizedMobile: phone(n), requirement: `ai-agent-test ${tag}`, ...(extra.ownerId ? { ownerId: extra.ownerId } : {}) },
    select: { id: true },
  });
  leadIds.push(l.id);
  return l.id;
}
async function order(leadId: string, o: { status?: "CONFIRMED" | "CANCELLED"; total?: string } = {}) {
  const total = o.total ?? "449.00";
  const row = await prisma.order.create({
    data: {
      orderNumber: `CRM-${tag}-${randomUUID().slice(0, 6)}`, leadId, status: o.status ?? "CONFIRMED", source: "SALESPERSON", currency: "INR", subtotal: total, totalAmount: total, metadata: { paymentMode: "COD" },
      items: { create: [{ productNameSnapshot: "P", quantity: 1, unitPrice: total, totalPrice: total, productId }] },
      payments: { create: [{ amount: total, currency: "INR", method: "COD" as const, status: "PENDING" as const }] },
    },
    select: { id: true, orderNumber: true },
  });
  orderIds.push(row.id);
  return row;
}
const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: JSON.stringify(body) });
  const json = (await res.json()) as any;
  if (json?.requestId) requestIds.push(json.requestId);
  return { status: res.status, json };
};
const body = (n: number, over: Record<string, unknown> = {}) => ({ customerName: "Test Customer", mobile: phone(n), ...over });
const aiRows = (where: object) => prisma.activity.findMany({ where: { source: "AI_AGENT", ...where }, orderBy: { createdAt: "asc" } });
const admin = { id: "00000000-0000-0000-0000-000000000000", role: "ADMIN" as const, username: "admin" };

before(async () => {
  const k = generateApiKey();
  key = k.key;
  keyId = (await prisma.agencyApiKey.create({ data: { name: `ai-${tag}`, keyPrefix: k.prefix, keyHash: k.hash, rateLimitPerMinute: 200 }, select: { id: true } })).id;
  templateId = (await prisma.whatsAppTemplate.create({ data: { name: `ai_pay_${tag}`, provider: "META", language: "en", body: "Hi {{customer_name}}, pay: {{payment_link}}", variables: ["customer_name", "payment_link"], status: "APPROVED", providerTemplateId: `meta-${tag}` }, select: { id: true } })).id;
  productId = (await prisma.product.create({ data: { name: "P", type: ProductType.PRODUCT, sku: `SKU-AI-${tag}`, basePrice: "449.00" }, select: { id: true } })).id;
  salesId = (await prisma.user.create({ data: { name: "Telecaller", username: `tele-${tag}`, role: "SALESPERSON" }, select: { id: true } })).id;
  const app = express();
  app.use("/api/agency", express.json({ limit: "32kb" }), createAgencyRouter({ repo: new PrismaAgencyRepo(), messaging: new WhatsAppMessagingService(prisma, undefined, async () => fakeMeta), links: fakeLinks, env: { AGENCY_PAYMENT_LINK_TEMPLATE: `ai_pay_${tag}` } }), agencyJsonErrorHandler);
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agency/whatsapp/payment-link`;
});

after(async () => {
  await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
  await prisma.activity.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { orderId: { in: orderIds } }, { referenceType: "AgencyMessageRequest", referenceId: { in: requestIds } }] } });
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
  await prisma.user.delete({ where: { id: salesId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("AI Agent activity (real storage)", () => {
  it("a valid request records ONE AI Agent activity against the matched lead: timestamp, name, normalized mobile, request + idempotency id, result PAYMENT_LINK_SENT", async () => {
    const l = await lead(1);
    const o = await order(l);
    const r = await post(body(1, { customerName: "Rahul Sharma" }), { "idempotency-key": `ai-${tag}-0001` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rows = await aiRows({ leadId: l });
    assert.equal(rows.length, 1);
    const a = rows[0]!;
    assert.equal(a.type, "AI_AGENT_PAYMENT_LINK_REQUEST");
    assert.equal(a.source, "AI_AGENT");
    assert.equal(a.actorId, null, "not attributed to any human user");
    assert.equal(a.orderId, o.id);
    assert.equal(a.referenceId, r.json.requestId);
    assert.ok(Date.now() - a.createdAt.getTime() < 60_000, "timestamp is the time of the request");
    assert.deepEqual(
      { ...(a.metadata as object) },
      { aiAgent: true, intent: "ALREADY_ORDERED", requestId: r.json.requestId, idempotencyKey: `ai-${tag}-0001`, customerName: "Rahul Sharma", normalizedMobile: phone(1), result: "PAYMENT_LINK_SENT", httpStatus: 200, apiKey: `ai-${tag}`, callOutcome: null },
    );
  });

  it("existing lead matching: no duplicate lead is created, and a number shared by two leads still creates none; the activity goes to the order's lead", async () => {
    const before = await prisma.lead.count({ where: { normalizedMobile: phone(2) } });
    const first = await lead(2, { name: "First" });
    const second = await lead(2, { name: "Second" });
    const o = await order(second);
    assert.equal(before, 0);
    const r = await post(body(2), { "idempotency-key": `ai-${tag}-0002` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(2) } }), 2, "still exactly the two leads that existed");
    assert.equal((await aiRows({ leadId: second })).length, 1);
    assert.equal((await aiRows({ leadId: first })).length, 0);
    assert.equal((await aiRows({ leadId: second }))[0]!.orderId, o.id);
  });

  it("NO_ELIGIBLE_ORDER is recorded against the existing lead (no new lead, nothing created or sent)", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(3);
    await order(l, { status: "CANCELLED" });
    const leadsBefore = await prisma.lead.count({ where: { normalizedMobile: phone(3) } });
    const r = await post(body(3), { "idempotency-key": `ai-${tag}-0003` });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "NO_ELIGIBLE_ORDER");
    const rows = await aiRows({ leadId: l });
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.metadata as any).result, "NO_ELIGIBLE_ORDER");
    assert.equal(rows[0]!.orderId, null);
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(3) } }), leadsBefore);
    assert.deepEqual([sent.length, linkCalls.length], [0, 0]);
  });

  it("CUSTOMER_NOT_FOUND is recorded without a lead, and no lead is created for the unknown number", async () => {
    const r = await post(body(4), { "idempotency-key": `ai-${tag}-0004` });
    assert.equal(r.json.error.code, "CUSTOMER_NOT_FOUND");
    const rows = await aiRows({ referenceId: r.json.requestId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.leadId, null);
    assert.equal((rows[0]!.metadata as any).result, "CUSTOMER_NOT_FOUND");
    assert.equal((rows[0]!.metadata as any).normalizedMobile, phone(4));
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(4) } }), 0, "the agency never creates a lead");
  });

  it("a duplicate webhook (same Idempotency-Key) records NO second activity", async () => {
    const l = await lead(5);
    await order(l);
    const first = await post(body(5), { "idempotency-key": `ai-${tag}-0005` });
    const again = await post(body(5), { "idempotency-key": `ai-${tag}-0005` });
    assert.equal(first.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal((await aiRows({ leadId: l })).length, 1);
  });

  it("a request is NOT a call: the lead's status, last-contacted time, owner and call records are untouched", async () => {
    const l = await lead(6, { ownerId: salesId });
    await order(l);
    const snap = () => prisma.lead.findUniqueOrThrow({ where: { id: l }, select: { workingStatus: true, lastContactedAt: true, lastActivityAt: true, ownerId: true, assignedManagerId: true, bucketDoneAt: true } });
    const before = await snap();
    const r = await post(body(6), { "idempotency-key": `ai-${tag}-0006` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(await snap(), before);
    assert.equal(await prisma.call.count({ where: { leadId: l } }), 0);
    assert.equal(await prisma.leadAssignment.count({ where: { leadId: l } }), 0);
    assert.equal(await prisma.task.count({ where: { leadId: l } }), 0);
  });
});

describe("AI Agent tag, filters and timeline (existing lead list / timeline, telecaller scope preserved)", () => {
  it("the lead list tags AI Agent leads separately from the human owner, and the aiAgent filter splits them", async () => {
    const tagged = await lead(10, { ownerId: salesId, name: `Tagged${tag}` });
    const plain = await lead(11, { ownerId: salesId, name: `Plain${tag}` });
    await order(tagged);
    await post(body(10), { "idempotency-key": `ai-${tag}-0010` });
    const svc = new LeadService();
    const rep = { id: salesId, role: "SALESPERSON" as const, username: `tele-${tag}` };
    const search = { page: 1, limit: 50, search: tag };
    const all = (await svc.listLeads(rep, search)).data;
    const t = all.find((x) => x.id === tagged)!;
    const p = all.find((x) => x.id === plain)!;
    assert.equal(t.aiAgent?.lastResult, "PAYMENT_LINK_SENT");
    assert.equal(p.aiAgent, null);
    assert.equal(t.owner?.id, salesId, "the human owner is unchanged and separate from the AI Agent tag");
    assert.equal("activities" in t, false, "the raw activities list is not leaked");
    const only = (await svc.listLeads(rep, { ...search, aiAgent: "ONLY" })).data.map((x) => x.id);
    const exclude = (await svc.listLeads(rep, { ...search, aiAgent: "EXCLUDE" })).data.map((x) => x.id);
    const mine = (ids: string[]) => ids.filter((id) => id === tagged || id === plain); // other tests' leads share this tag
    assert.deepEqual(mine(only), [tagged]);
    assert.deepEqual(mine(exclude), [plain]);
  });

  it("permissions are unchanged: a telecaller still sees only their own leads, AI-tagged or not", async () => {
    const mine = await lead(12, { ownerId: salesId, name: `Mine${tag}` });
    const theirs = await lead(13, { name: `Theirs${tag}` });
    await order(theirs);
    await post(body(13), { "idempotency-key": `ai-${tag}-0013` });
    const svc = new LeadService();
    const rep = { id: salesId, role: "SALESPERSON" as const, username: `tele-${tag}` };
    const ids = (await svc.listLeads(rep, { page: 1, limit: 50, search: tag, aiAgent: "ONLY" })).data.map((x) => x.id);
    assert.equal(ids.includes(theirs), false, "an AI-tagged lead owned by nobody is not exposed to a telecaller");
    assert.equal(ids.includes(mine), false);
    const adminIds = (await svc.listLeads(admin, { page: 1, limit: 50, search: tag, aiAgent: "ONLY" })).data.map((x) => x.id);
    assert.equal(adminIds.includes(theirs), true);
  });

  it("the lead's existing timeline shows the AI Agent activity; the filter shows only it, or everything but it", async () => {
    const l = await lead(14);
    await order(l);
    await post(body(14), { "idempotency-key": `ai-${tag}-0014` });
    const svc = new CustomersService();
    const q = { page: 1, pageSize: 50 };
    const all = (await svc.getTimeline(admin, l, q)).entries;
    const ai = all.filter((e) => e.type === "AI_AGENT_PAYMENT_LINK");
    assert.equal(ai.length, 1);
    assert.equal(ai[0]!.actor, null);
    assert.match(ai[0]!.title, /AI Agent/);
    assert.match(ai[0]!.description ?? "", new RegExp(`${phone(14).replace("+", "\\+")}.*PAYMENT_LINK_SENT`));
    assert.ok(all.some((e) => e.type === "LEAD_CREATED"), "the rest of the timeline is still there");
    const only = (await svc.getTimeline(admin, l, { ...q, aiAgent: "ONLY" })).entries;
    assert.deepEqual(only.map((e) => e.type), ["AI_AGENT_PAYMENT_LINK"]);
    const exclude = (await svc.getTimeline(admin, l, { ...q, aiAgent: "EXCLUDE" })).entries;
    assert.equal(exclude.some((e) => e.type === "AI_AGENT_PAYMENT_LINK"), false);
    assert.equal(exclude.length, all.length - 1);
  });
});

describe("intents: ALREADY_ORDERED and INTERESTED (real storage)", () => {
  const rep = () => ({ id: salesId, role: "SALESPERSON" as const, username: `tele-${tag}` });

  it("ALREADY_ORDERED (explicit) and a legacy request WITHOUT intent both create the link, send the message and record intent ALREADY_ORDERED", async () => {
    sent.length = 0; linkCalls.length = 0;
    const a = await lead(30); const oa = await order(a);
    const b = await lead(31); const ob = await order(b);
    const explicit = await post(body(30, { intent: "ALREADY_ORDERED" }), { "idempotency-key": `ai-${tag}-0030` });
    const legacy = await post(body(31), { "idempotency-key": `ai-${tag}-0031` });
    assert.equal(explicit.status, 200, JSON.stringify(explicit.json));
    assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
    assert.deepEqual(linkCalls, [oa.id, ob.id]);
    assert.equal(sent.length, 2);
    assert.equal(((await aiRows({ leadId: a }))[0]!.metadata as any).intent, "ALREADY_ORDERED");
    assert.equal(((await aiRows({ leadId: b }))[0]!.metadata as any).intent, "ALREADY_ORDERED");
  });

  it("ALREADY_ORDERED with no eligible order records NO_ELIGIBLE_ORDER with its intent", async () => {
    const l = await lead(32);
    await order(l, { status: "CANCELLED" });
    const r = await post(body(32, { intent: "ALREADY_ORDERED" }), { "idempotency-key": `ai-${tag}-0032` });
    assert.equal(r.json.error.code, "NO_ELIGIBLE_ORDER");
    const m = (await aiRows({ leadId: l }))[0]!.metadata as any;
    assert.deepEqual([m.intent, m.result], ["ALREADY_ORDERED", "NO_ELIGIBLE_ORDER"]);
  });

  it("INTERESTED with an existing lead: recorded on the lead; NO payment link, NO WhatsApp message, NO payment, NO lead change (status, owner, assignment, last contacted, calls)", async () => {
    sent.length = 0; linkCalls.length = 0;
    const l = await lead(33, { ownerId: salesId });
    await order(l); // even with an eligible COD order, INTERESTED does not look at it
    const paymentsBefore = await prisma.payment.count({ where: { order: { leadId: l } } });
    const snap = () => prisma.lead.findUniqueOrThrow({ where: { id: l }, select: { workingStatus: true, lastContactedAt: true, lastActivityAt: true, ownerId: true, assignedManagerId: true, bucketDoneAt: true, priority: true, lifecycleStage: true, updatedAt: true } });
    const before = await snap();
    const r = await post(body(33, { intent: "INTERESTED" }), { "idempotency-key": `ai-${tag}-0033` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.status, r.json.intent, r.json.leadMatched], ["RECORDED", "INTERESTED", true]);
    assert.deepEqual([sent.length, linkCalls.length], [0, 0], "no WhatsApp message, no payment link");
    assert.equal(await prisma.payment.count({ where: { order: { leadId: l } } }), paymentsBefore);
    assert.equal(await prisma.whatsAppMessage.count({ where: { leadId: l } }), 0);
    assert.deepEqual(await snap(), before, "the lead is exactly as it was");
    assert.equal(await prisma.call.count({ where: { leadId: l } }), 0);
    assert.equal(await prisma.leadAssignment.count({ where: { leadId: l } }), 0);
    const rows = await aiRows({ leadId: l });
    assert.equal(rows.length, 1);
    const m = rows[0]!.metadata as any;
    assert.deepEqual([m.intent, m.result, m.normalizedMobile, m.requestId, m.idempotencyKey, m.callOutcome], ["INTERESTED", "INTERESTED_RECORDED", phone(33), r.json.requestId, `ai-${tag}-0033`, null]);
    assert.equal(rows[0]!.orderId, null);
    const logged = await prisma.agencyMessageRequest.findUniqueOrThrow({ where: { id: r.json.requestId }, select: { status: true, leadId: true } });
    assert.deepEqual([logged.status, logged.leadId], ["RECORDED", l]);
  });

  it("INTERESTED with an unknown mobile: 200, recorded with no lead (admin audit trail only); no lead is created", async () => {
    const r = await post(body(34, { intent: "INTERESTED" }), { "idempotency-key": `ai-${tag}-0034` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.leadMatched, false);
    const rows = await aiRows({ referenceId: r.json.requestId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.leadId, null);
    assert.equal((rows[0]!.metadata as any).result, "INTERESTED_NO_LEAD");
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(34) } }), 0);
  });

  it("INTERESTED duplicate Idempotency-Key: same answer, one activity; a shared number still creates no lead", async () => {
    const first = await lead(35, { name: "First" });
    await lead(35, { name: "Second" });
    const a = await post(body(35, { intent: "INTERESTED" }), { "idempotency-key": `ai-${tag}-0035` });
    const b = await post(body(35, { intent: "INTERESTED" }), { "idempotency-key": `ai-${tag}-0035` });
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.requestId, a.json.requestId);
    assert.equal((await aiRows({ leadId: first })).length, 1, "recorded on the oldest lead with this number, once");
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: phone(35) } }), 2);
  });

  it("tags and filters: 'Interested - AI Agent' only for interested leads; the intent filter splits Already ordered / Interested; AI Agent and telecaller filters still work; the timeline shows the intent", async () => {
    const interested = await lead(36, { ownerId: salesId, name: `Int${tag}` });
    const ordered = await lead(37, { ownerId: salesId, name: `Ord${tag}` });
    const untouched = await lead(38, { ownerId: salesId, name: `Non${tag}` });
    await order(ordered);
    await post(body(36, { intent: "INTERESTED" }), { "idempotency-key": `ai-${tag}-0036` });
    await post(body(37, { intent: "ALREADY_ORDERED" }), { "idempotency-key": `ai-${tag}-0037` });
    const svc = new LeadService();
    const search = { page: 1, limit: 100, search: tag };
    const list = (await svc.listLeads(rep(), search)).data;
    const mine = (ids: string[]) => ids.filter((id) => [interested, ordered, untouched].includes(id)).sort();
    const get = (id: string) => list.find((x) => x.id === id)!;
    assert.deepEqual([get(interested).aiAgent?.interested, get(interested).aiAgent?.lastIntent], [true, "INTERESTED"]);
    assert.deepEqual([get(ordered).aiAgent?.interested, get(ordered).aiAgent?.lastIntent], [false, "ALREADY_ORDERED"], "an ordered lead is AI Agent tagged but not 'Interested'");
    assert.equal(get(untouched).aiAgent, null);
    assert.equal("_count" in get(interested), false, "no raw relation data leaked");
    const ids = async (extra: object) => mine((await svc.listLeads(rep(), { ...search, ...extra })).data.map((x) => x.id));
    assert.deepEqual(await ids({ aiAgentIntent: "INTERESTED" }), [interested]);
    assert.deepEqual(await ids({ aiAgentIntent: "ALREADY_ORDERED" }), [ordered]);
    assert.deepEqual(await ids({ aiAgent: "ONLY" }), [interested, ordered].sort());
    assert.deepEqual(await ids({ aiAgent: "EXCLUDE" }), [untouched]);
    assert.deepEqual(await ids({ aiAgent: "EXCLUDE", aiAgentIntent: "INTERESTED" }), [], "contradictory filters combine, they do not widen");
    assert.deepEqual(await ids({}), [interested, ordered, untouched].sort(), "no filter: unchanged");

    const cust = new CustomersService();
    const q = { page: 1, pageSize: 50 };
    const all = (await cust.getTimeline(admin, interested, q)).entries;
    const ai = all.filter((e) => e.type === "AI_AGENT_INTERESTED");
    assert.equal(ai.length, 1);
    assert.match(ai[0]!.description ?? "", /INTERESTED/);
    assert.equal(all.some((e) => e.type === "AI_AGENT_PAYMENT_LINK"), false);
    assert.deepEqual((await cust.getTimeline(admin, interested, { ...q, aiAgentIntent: "INTERESTED" })).entries.map((e) => e.type), ["AI_AGENT_INTERESTED"]);
    assert.deepEqual((await cust.getTimeline(admin, interested, { ...q, aiAgentIntent: "ALREADY_ORDERED" })).entries, []);
    assert.deepEqual((await cust.getTimeline(admin, interested, { ...q, aiAgent: "ONLY" })).entries.map((e) => e.type), ["AI_AGENT_INTERESTED"]);
    assert.equal((await cust.getTimeline(admin, interested, { ...q, aiAgent: "EXCLUDE" })).entries.length, all.length - 1);
    const oTimeline = (await cust.getTimeline(admin, ordered, q)).entries;
    assert.equal(oTimeline.filter((e) => e.type === "AI_AGENT_PAYMENT_LINK").length, 1);
  });

  it("telecaller visibility is unchanged: an INTERESTED lead nobody owns is invisible to a telecaller and visible to an admin", async () => {
    const orphan = await lead(39, { name: `Orph${tag}` });
    await post(body(39, { intent: "INTERESTED" }), { "idempotency-key": `ai-${tag}-0039` });
    const svc = new LeadService();
    const q = { page: 1, limit: 100, search: tag, aiAgentIntent: "INTERESTED" as const };
    assert.equal((await svc.listLeads(rep(), q)).data.some((x) => x.id === orphan), false);
    assert.equal((await svc.listLeads(admin, q)).data.some((x) => x.id === orphan), true);
  });
});
