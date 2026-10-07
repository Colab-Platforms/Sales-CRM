// End-to-end check of the approved Meta template `prepaid_template` (UTILITY, en, 4 named body variables) through the real CRM path:
// notifyPaymentLink -> template selection -> variable resolution -> WhatsAppMessagingService -> the REAL MetaCloudApiProvider, with only the
// network faked. The request Meta would receive is asserted field by field. Every test runs in ONE rolled-back transaction.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
import { notifyPaymentLink } from "./whatsapp.order-notify.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const creds = { phoneNumberId: "PHONE-123", businessAccountId: "WABA-1", accessToken: "EAA-test-token", appSecret: "s", verifyToken: "v", graphApiVersion: "v21.0" };
const APPROVED_BODY = "Hi {{customer_name}},\n\nYour order {{order_number}} has been created successfully.\n\nOrder amount: ₹{{amount}}\n\nPlease complete your payment using the link below:\n{{payment_link}}\n\nThank you,\nAyush Wellness";
const NOW = new Date();

async function world(tx: Prisma.TransactionClient, o: { orderTotal: string; linkAmount: string; inboundHoursAgo?: number | null; url?: string; conversation?: boolean; consent?: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN" | null; mobile?: string | null }) {
  const user = await tx.user.create({ data: { name: "Tele", username: `t-${uid()}`, role: Role.ADMIN } });
  const mobile = o.mobile === undefined ? "+919876543210" : o.mobile;
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Vishwa", mobile: mobile ? mobile.slice(3) : null, normalizedMobile: mobile }, select: { id: true } });
  if (o.conversation !== false) await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: "META" } });
  if (o.consent) await tx.communicationPreference.create({ data: { leadId: lead.id, channel: "WHATSAPP", status: o.consent, source: "test", consentAt: o.consent === "OPTED_IN" ? NOW : null } });
  if (o.inboundHoursAgo != null) {
    const at = new Date(NOW.getTime() - o.inboundHoursAgo * 3_600_000);
    await tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `in-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId: lead.id, fromNumber: "919876543210", normalizedContact: "+919876543210", body: "hi", receivedAt: at, createdAt: at } });
  }
  // The approved template's exact definition. Named so it sorts ahead of any real synced copy in the dev DB.
  const template = await tx.whatsAppTemplate.create({
    data: { name: `aa_prepaid_template_${uid().slice(0, 6)}`, provider: "META", providerTemplateId: `114${Math.floor(Math.random() * 1e12)}`, language: "en", category: "UTILITY", body: APPROVED_BODY, variables: ["customer_name", "order_number", "amount", "payment_link"], status: "APPROVED" },
    select: { id: true, name: true },
  });
  const order = await tx.order.create({ data: { orderNumber: `AWL-TEST-${uid().slice(0, 6)}`, leadId: lead.id, source: "SALESPERSON", status: "PENDING_PAYMENT", totalAmount: o.orderTotal, currency: "INR" }, select: { id: true, orderNumber: true } });
  const url = o.url ?? `https://payments.cashfree.com/links/${uid().slice(0, 10)}`;
  await tx.payment.create({ data: { orderId: order.id, amount: o.linkAmount, currency: "INR", method: "OTHER", status: "PENDING", provider: "CASHFREE", paymentUrl: url, paymentExpiresAt: new Date(NOW.getTime() + 24 * 3_600_000) } });
  const requests: any[] = [];
  const fetchImpl = (async (_u: string, init: any) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.T1" }] }), { status: 200 }); }) as unknown as typeof fetch;
  const meta = new MetaCloudApiProvider(creds, { fetchImpl });
  const deps = { messaging: new WhatsAppMessagingService(tx, () => null, async () => meta), freeText: new WhatsAppFreeTextService(tx, async () => meta, () => NOW) };
  const send = () => notifyPaymentLink(tx, { id: user.id, username: user.username, role: Role.ADMIN }, { leadId: lead.id, orderId: order.id, normalizedMobile: mobile, orderNumber: order.orderNumber, paymentUrl: url, amount: o.linkAmount, currency: "INR", customerName: "Vishwa" }, deps);
  return { send, requests, template, order, url, lead };
}

describe("prepaid_template through the real CRM path (window closed -> template)", () => {
  it("sends the approved template BY NAME with language en and all four variables as named BODY parameters, in order - the link is a body variable, not a button", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: 30 });
      const result = await w.send();
      assert.deepEqual(result, { sent: true, via: "TEMPLATE", provider: "META", templateName: w.template.name });
      assert.equal(w.requests.length, 1);
      const req = w.requests[0];
      assert.equal(req.messaging_product, "whatsapp");
      assert.equal(req.to, "+919876543210");
      assert.equal(req.type, "template");
      assert.equal(req.template.name, w.template.name, "Meta is addressed by template NAME, not the numeric template id");
      assert.equal(req.template.language.code, "en");
      assert.equal(req.template.components.length, 1, "no button component: the Cashfree URL is NOT a dynamic CTA");
      const body = req.template.components[0];
      assert.equal(body.type, "body");
      assert.deepEqual(body.parameters.map((p: any) => p.parameter_name), ["customer_name", "order_number", "amount", "payment_link"]);
      assert.ok(body.parameters.every((p: any) => p.type === "text"));
      const v = Object.fromEntries(body.parameters.map((p: any) => [p.parameter_name, p.text]));
      assert.equal(v.customer_name, "Vishwa");
      assert.equal(v.order_number, w.order.orderNumber);
      assert.equal(v.payment_link, w.url, "the generated Cashfree URL, untouched");
      assert.equal(v.amount, "449", "the template already prints the rupee sign, so the value must not repeat it");
    });
  });

  it("renders exactly the approved wording (one rupee sign), and the stored message body matches what the customer sees", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: null });
      await w.send();
      const stored = await tx.whatsAppMessage.findFirstOrThrow({ where: { orderId: w.order.id, direction: "OUTBOUND" }, select: { body: true, messageType: true } });
      assert.equal(stored.messageType, "TEMPLATE");
      assert.equal(stored.body, `Hi Vishwa,\n\nYour order ${w.order.orderNumber} has been created successfully.\n\nOrder amount: ₹449\n\nPlease complete your payment using the link below:\n${w.url}\n\nThank you,\nAyush Wellness`);
      assert.ok(!stored.body!.includes("₹₹"));
    });
  });

  it("the amount is the FINAL prepaid amount from the order's own payment link, not the original COD total", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { orderTotal: "1249.00", linkAmount: "1199.00", inboundHoursAgo: 48 });
      await w.send();
      const v = Object.fromEntries(w.requests[0].template.components[0].parameters.map((p: any) => [p.parameter_name, p.text]));
      assert.equal(v.amount, "1,199");
    });
  });

  it("paise are kept (₹749.50), and every order gets its own link (two orders -> two different payment_link values, none hardcoded)", async () => {
    await inRollback(async (tx) => {
      const a = await world(tx, { orderTotal: "749.50", linkAmount: "749.50", inboundHoursAgo: 40 });
      const b = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: 40 });
      await a.send();
      await b.send();
      const va = Object.fromEntries(a.requests[0].template.components[0].parameters.map((p: any) => [p.parameter_name, p.text]));
      const vb = Object.fromEntries(b.requests[0].template.components[0].parameters.map((p: any) => [p.parameter_name, p.text]));
      assert.equal(va.amount, "749.50");
      assert.notEqual(va.payment_link, vb.payment_link);
      assert.equal(va.payment_link, a.url);
      assert.equal(vb.payment_link, b.url);
    });
  });
});

describe("24-hour window: which message is used", () => {
  it("INSIDE the window the existing free-text payment message is sent (no template)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: 2 });
      const result = await w.send();
      assert.deepEqual(result, { sent: true, via: "FREE_TEXT", provider: "META" });
      assert.equal(w.requests[0].type, "text");
      assert.ok(w.requests[0].text.body.includes(w.url));
    });
  });
  it("OUTSIDE the window (and with no inbound at all) the approved template is used instead", async () => {
    await inRollback(async (tx) => {
      for (const hours of [25, 200, null] as const) {
        const w = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: hours });
        assert.equal((await w.send()).via, "TEMPLATE", String(hours));
        assert.equal(w.requests[0].type, "template");
      }
    });
  });
});

describe("first contact: a customer who has never messaged the business", () => {
  const first = { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: null, conversation: false } as const;

  it("with a valid number AND a recorded WhatsApp opt-in, the approved template starts the conversation with the four variables", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { ...first, consent: "OPTED_IN" });
      const result = await w.send();
      assert.deepEqual(result, { sent: true, via: "TEMPLATE", provider: "META", templateName: w.template.name });
      assert.equal(w.requests.length, 1);
      const req = w.requests[0];
      assert.equal(req.type, "template");
      assert.equal(req.template.name, w.template.name);
      assert.equal(req.template.language.code, "en");
      assert.deepEqual(req.template.components[0].parameters.map((p: any) => p.parameter_name), ["customer_name", "order_number", "amount", "payment_link"]);
      const v = Object.fromEntries(req.template.components[0].parameters.map((p: any) => [p.parameter_name, p.text]));
      assert.deepEqual([v.customer_name, v.order_number, v.amount, v.payment_link], ["Vishwa", w.order.orderNumber, "449", w.url]);
    });
  });

  it("each first-contact order carries its OWN Cashfree link", async () => {
    await inRollback(async (tx) => {
      const a = await world(tx, { ...first, consent: "OPTED_IN" });
      const b = await world(tx, { ...first, consent: "OPTED_IN" });
      await a.send();
      await b.send();
      const link = (w: typeof a) => w.requests[0].template.components[0].parameters.find((p: any) => p.parameter_name === "payment_link").text;
      assert.equal(link(a), a.url);
      assert.equal(link(b), b.url);
      assert.notEqual(link(a), link(b));
    });
  });

  it("no WhatsApp number -> safely rejected, nothing sent", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { ...first, consent: "OPTED_IN", mobile: null });
      const result = await w.send();
      assert.equal(result.sent, false);
      assert.match(result.reason ?? "", /no valid WhatsApp\/mobile number/);
      assert.equal(w.requests.length, 0);
    });
  });

  for (const consent of [null, "UNKNOWN", "OPTED_OUT"] as const) {
    it(`consent ${consent ?? "not recorded"} -> safely rejected, nothing sent, and the reason says why`, async () => {
      await inRollback(async (tx) => {
        const w = await world(tx, { ...first, consent });
        const result = await w.send();
        assert.deepEqual([result.sent, result.via], [false, null]);
        assert.match(result.reason ?? "", consent === "OPTED_OUT" ? /opted out/ : /no WhatsApp opt-in is recorded/);
        assert.equal(w.requests.length, 0);
      });
    });
  }

  it("existing conversations are unchanged: no consent row is needed to message a customer who is already in a conversation", async () => {
    await inRollback(async (tx) => {
      const inside = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: 2, consent: null });
      assert.equal((await inside.send()).via, "FREE_TEXT");
      const outside = await world(tx, { orderTotal: "449.00", linkAmount: "449.00", inboundHoursAgo: 30, consent: null });
      assert.equal((await outside.send()).via, "TEMPLATE");
    });
  });

  it("a Meta rejection on the first-contact send never leaks the token into the stored message, the activity or the result", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { ...first, consent: "OPTED_IN" });
      const leaky = (async () => new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${creds.accessToken}`, code: 190 } }), { status: 401 })) as unknown as typeof fetch;
      const meta = new MetaCloudApiProvider(creds, { fetchImpl: leaky });
      const result = await notifyPaymentLink(tx, { id: (await tx.user.findFirstOrThrow({ select: { id: true } })).id, username: "test-user", role: Role.ADMIN }, { leadId: w.lead.id, orderId: w.order.id, normalizedMobile: "+919876543210", orderNumber: w.order.orderNumber, paymentUrl: w.url, amount: "449.00", currency: "INR", customerName: "Vishwa" }, { messaging: new WhatsAppMessagingService(tx, () => null, async () => meta), freeText: new WhatsAppFreeTextService(tx, async () => meta, () => NOW) });
      const rows = await tx.whatsAppMessage.findMany({ where: { orderId: w.order.id }, select: { errorMessage: true, body: true } });
      const acts = await tx.activity.findMany({ where: { leadId: w.lead.id }, select: { description: true, title: true } });
      assert.equal(result.sent, false);
      assert.ok(!JSON.stringify({ result, rows, acts }).includes(creds.accessToken));
      assert.match(JSON.stringify(rows), /HTTP 401/);
    });
  });
});
