// "Create Order & Send Payment Link via WhatsApp": the whole backend path (validation -> order -> Cashfree link -> chosen approved Meta
// template through the REAL Meta provider over a fake network). Every test runs in ONE rolled-back transaction.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { MetaCloudApiProvider } from "../whatsapp/whatsapp.meta.provider.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import WhatsAppFreeTextService from "../whatsapp/whatsapp.freetext.service.js";
import { notifyPaymentLink } from "../whatsapp/whatsapp.order-notify.service.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const creds = { phoneNumberId: "PHONE-1", businessAccountId: "WABA-1", accessToken: "EAA-order-test-token-5512", appSecret: "app-secret-4410", verifyToken: "v-token-9931", graphApiVersion: "v21.0" };
const BODY = "Hi {{customer_name}},\n\nYour order {{order_number}} has been created successfully.\n\nOrder amount: ₹{{amount}}\n\nPlease complete your payment using the link below:\n{{payment_link}}\n\nThank you,\nAyush Wellness";
const NOW = new Date();
const fakeShopify = () => ({ query: async () => ({ orderCreate: { order: { id: `gid://shopify/Order/${uid()}`, name: "#T1" }, userErrors: [] } }) }) as unknown as ShopifyClient;

interface Opts { mobile?: string | null; conversation?: boolean; consent?: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN"; metaStatus?: number }

async function world(tx: Prisma.TransactionClient, o: Opts = {}) {
  // Isolation: the dev DB holds the real synced `prepaid_template`; these tests pick among the templates THEY create.
  await tx.whatsAppTemplate.updateMany({ where: { status: "APPROVED" }, data: { status: "DISABLED" } });
  const mobile = o.mobile === undefined ? "+919876543210" : o.mobile;
  const user = await tx.user.create({ data: { name: "Tele", email: `t-${uid()}@example.invalid`, role: Role.ADMIN } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Vishwa", mobile: mobile ? mobile.slice(3) : null, normalizedMobile: mobile }, select: { id: true } });
  if (o.conversation) await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: "META" } });
  if (o.consent) await tx.communicationPreference.create({ data: { leadId: lead.id, channel: "WHATSAPP", status: o.consent, consentAt: o.consent === "OPTED_IN" ? new Date("2026-01-01T00:00:00Z") : null, source: "earlier" } });
  const product = await tx.product.create({ data: { name: "Herbal Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "449.00" }, select: { id: true } });
  const mk = (name: string, over: Partial<Prisma.WhatsAppTemplateUncheckedCreateInput> = {}) =>
    tx.whatsAppTemplate.create({ data: { name: `${name}_${uid().slice(0, 6)}`, provider: "META", providerTemplateId: `114${Math.floor(Math.random() * 1e12)}`, language: "en", category: "UTILITY", body: BODY, variables: ["customer_name", "order_number", "amount", "payment_link"], status: "APPROVED", ...over }, select: { id: true, name: true } });
  const requests: any[] = [];
  const status = o.metaStatus ?? 200;
  const fetchImpl = (async (_u: string, init: any) => {
    requests.push(JSON.parse(init.body));
    return status === 200 ? new Response(JSON.stringify({ messages: [{ id: `wamid.${uid()}` }] }), { status }) : new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${creds.accessToken}`, code: 190 } }), { status });
  }) as unknown as typeof fetch;
  let currentFetch = fetchImpl;
  const meta = new MetaCloudApiProvider(creds, { fetchImpl: ((u: string, i: any) => currentFetch(u, i)) as typeof fetch });
  const deps = { messaging: new WhatsAppMessagingService(tx, () => null, async () => meta), freeText: new WhatsAppFreeTextService(tx, async () => meta, () => NOW) };
  const notify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: (db: any, u: any, p: any) => notifyPaymentLink(db, u, p, deps) } as never;
  const links: string[] = [];
  const cashfree = {
    createPaymentLink: async (_u: unknown, orderId: string) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalAmount: true } });
      const url = `https://payments.cashfree.com/links/${uid().slice(0, 10)}`;
      links.push(url);
      const p = await tx.payment.create({ data: { orderId, amount: order.totalAmount, currency: "INR", method: "OTHER", status: "PENDING", provider: "CASHFREE", paymentUrl: url, paymentExpiresAt: new Date(NOW.getTime() + 86_400_000) }, select: { id: true } });
      return { reused: false, paymentId: p.id, paymentUrl: url, expiresAt: null, amount: order.totalAmount.toString(), currency: "INR" };
    },
    cancelPaymentLink: async () => ({}),
  } as never;
  const svc = new OrdersService(tx as never, () => fakeShopify(), () => cashfree, notify);
  const as = { id: user.id, email: user.email, role: Role.ADMIN };
  const create = (extra: Record<string, unknown> = {}) => svc.createManualOrder(as, { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "449.00" }], paymentMethod: "PAYMENT_LINK", ...extra } as never);
  const ordersFor = () => tx.order.count({ where: { leadId: lead.id } });
  const pref = () => tx.communicationPreference.findMany({ where: { leadId: lead.id, channel: "WHATSAPP" } });
  return { svc, create, mk, requests, links, ordersFor, pref, lead, as, deps, setFetch: (f: typeof fetch) => { currentFetch = f; }, tx };
}
const params = (req: any) => Object.fromEntries(req.template.components[0].parameters.map((p: any) => [p.parameter_name, p.text]));

describe("Create Order & Send Payment Link via WhatsApp", () => {
  it("consent ticked + approved template: order created, consent recorded, Cashfree link generated, template sent with the four order-specific variables (no ₹₹)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const tpl = await w.mk("prepaid_like");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(w.links.length, 1);
      assert.deepEqual(r.whatsapp, { sent: true, via: "TEMPLATE", provider: "META", templateName: tpl.name }, "the result names the template that was sent");
      assert.equal(w.requests.length, 1);
      const req = w.requests[0];
      assert.equal(req.template.name, tpl.name, "sent by NAME, not the numeric Meta template id");
      assert.equal(req.template.language.code, "en");
      assert.equal(req.template.components.length, 1);
      assert.deepEqual(req.template.components[0].parameters.map((p: any) => p.parameter_name), ["customer_name", "order_number", "amount", "payment_link"]);
      assert.deepEqual([params(req).customer_name, params(req).order_number, params(req).amount, params(req).payment_link], ["Vishwa", r.order.orderNumber, "449", w.links[0]]);
      const stored = await tx.whatsAppMessage.findFirstOrThrow({ where: { orderId: r.order.id }, select: { body: true } });
      assert.ok(!stored.body!.includes("₹₹") && stored.body!.includes("Order amount: ₹449"));
      const prefs = await w.pref();
      assert.deepEqual([prefs.length, prefs[0]!.status, prefs[0]!.source, Boolean(prefs[0]!.consentAt)], [1, "OPTED_IN", "CREATE_ORDER", true]);
    });
  });

  it("with several approved payment templates, the SELECTED one is what is sent (not prepaid_template), by its own name, with that order's link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const first = await w.mk("prepaid_template_like");
      const second = await w.mk("payment_reminder_like");
      const options = await w.svc.getWhatsAppPaymentOptions(w.as, w.lead.id);
      assert.ok(options.templates.some((t) => t.id === first.id) && options.templates.some((t) => t.id === second.id), "both valid templates are offered");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: second.id, whatsappConsent: true });
      assert.equal(r.whatsapp.templateName, second.name);
      assert.equal(w.requests.length, 1);
      assert.equal(w.requests[0].template.name, second.name);
      assert.notEqual(w.requests[0].template.name, first.name);
      assert.equal(params(w.requests[0]).payment_link, w.links[0]);
      assert.equal(params(w.requests[0]).order_number, r.order.orderNumber);
    });
  });

  it("first contact (no conversation, no history) with the ticked consent: the template initiates the conversation", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: false });
      const tpl = await w.mk("prepaid_like");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.deepEqual(r.whatsapp, { sent: true, via: "TEMPLATE", provider: "META", templateName: tpl.name });
      assert.equal(w.requests[0].type, "template");
    });
  });

  it("an existing OPTED_IN is preserved (no duplicate, same consentAt) and the checkbox is not needed", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: false, consent: "OPTED_IN" });
      const tpl = await w.mk("prepaid_like");
      const before = (await w.pref())[0]!;
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id });
      assert.equal(r.whatsapp.sent, true);
      const after = await w.pref();
      assert.deepEqual([after.length, after[0]!.consentAt?.toISOString(), after[0]!.source], [1, before.consentAt?.toISOString(), "earlier"]);
    });
  });

  it("UNKNOWN consent + ticked checkbox is upgraded to OPTED_IN in place (still one record)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { consent: "UNKNOWN" });
      const tpl = await w.mk("prepaid_like");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.equal(r.whatsapp.sent, true);
      const prefs = await w.pref();
      assert.deepEqual([prefs.length, prefs[0]!.status], [1, "OPTED_IN"]);
    });
  });

  it("OPTED_OUT is never overwritten: clear error, no order, no message", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { consent: "OPTED_OUT", conversation: true });
      const tpl = await w.mk("prepaid_like");
      await assert.rejects(() => w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true }), (e: any) => e.statusCode === 400 && /opted out/.test(e.message) && /consent flow/.test(e.message));
      assert.equal(await w.ordersFor(), 0);
      assert.equal(w.requests.length, 0);
      assert.equal((await w.pref())[0]!.status, "OPTED_OUT");
    });
  });

  it("no consent -> 400 with the required wording, nothing created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const tpl = await w.mk("prepaid_like");
      await assert.rejects(() => w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id }), (e: any) => e.statusCode === 400 && e.message === "Payment link not sent — WhatsApp consent is required before sending a business-initiated message.");
      assert.deepEqual([await w.ordersFor(), (await w.pref()).length, w.requests.length], [0, 0, 0]);
    });
  });

  it("no WhatsApp number -> 400, nothing created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { mobile: null });
      const tpl = await w.mk("prepaid_like");
      await assert.rejects(() => w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true }), (e: any) => e.statusCode === 400 && e.message === "Payment link not sent — this customer does not have a valid WhatsApp number.");
      assert.deepEqual([await w.ordersFor(), (await w.pref()).length], [0, 0]);
    });
  });

  it("a template that is not an approved Meta payment template is refused: pending, non-payment, other provider, unknown id", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const bad = [
        await w.mk("pending_tpl", { status: "PENDING" }),
        await w.mk("no_link", { variables: ["customer_name"], body: "Hi {{customer_name}}" }),
        await w.mk("not_synced", { providerTemplateId: null }),
        await w.mk("other_provider", { provider: "GUPSHUP" }),
      ];
      for (const t of bad) await assert.rejects(() => w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: t.id, whatsappConsent: true }), (e: any) => e.statusCode === 400 && /selected WhatsApp template is not available or approved/.test(e.message), t.name);
      await assert.rejects(() => w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: uid(), whatsappConsent: true }), (e: any) => e.statusCode === 400);
      assert.equal(await w.ordersFor(), 0);
    });
  });

  it("only prepaid (payment-link) orders can send a WhatsApp payment link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const tpl = await w.mk("prepaid_like");
      await assert.rejects(() => w.create({ paymentMethod: "COD", sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true }), (e: any) => e.statusCode === 400);
      assert.equal(await w.ordersFor(), 0);
    });
  });

  it("Don't send: the order and Cashfree link are created, no WhatsApp request is made and no consent is recorded", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      await w.mk("prepaid_like");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: false, whatsappConsent: true });
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(r.whatsapp.sent, false);
      assert.equal(w.requests.length, 0);
      assert.equal((await w.pref()).length, 0);
    });
  });

  it("a send failure never undoes the order: order and link are kept, the reason is plain and secret-free, and a retry afterwards works", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true, metaStatus: 401 });
      const tpl = await w.mk("prepaid_like");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.equal(await w.ordersFor(), 1, "order kept");
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(r.whatsapp.sent, false);
      assert.match(r.whatsapp.reason ?? "", /^Payment link not sent — /);
      const stored = await tx.whatsAppMessage.findMany({ where: { orderId: r.order.id }, select: { errorMessage: true, status: true } });
      const acts = await tx.activity.findMany({ where: { leadId: w.lead.id }, select: { description: true } });
      const everything = JSON.stringify({ r, stored, acts });
      for (const secret of [creds.accessToken, creds.appSecret, creds.verifyToken]) assert.ok(!everything.includes(secret), "no credential anywhere");
      assert.match(everything, /HTTP 401/);
      // Retry (the existing send-payment-link action = notifyPaymentLink on the same order) once Meta works.
      w.setFetch((async (_u: string, init: any) => { w.requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${uid()}` }] }), { status: 200 }); }) as unknown as typeof fetch);
      const again = await notifyPaymentLink(tx, w.as, { leadId: w.lead.id, orderId: r.order.id, normalizedMobile: "+919876543210", orderNumber: r.order.orderNumber, paymentUrl: w.links[0]!, amount: "449.00", currency: "INR", customerName: "Vishwa", templateId: tpl.id }, w.deps);
      assert.equal(again.sent, true);
      assert.equal(params(w.requests.at(-1)).payment_link, w.links[0]);
    });
  });

  it("a failed send for a first-contact customer still records the consent that was ticked, and keeps the order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: false, metaStatus: 500 });
      const tpl = await w.mk("prepaid_like");
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.equal(await w.ordersFor(), 1);
      assert.equal(r.whatsapp.sent, false);
      assert.equal((await w.pref())[0]!.status, "OPTED_IN");
    });
  });

  it("two orders get two different links, each sent in its own message", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const tpl = await w.mk("prepaid_like");
      await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id });
      assert.equal(w.requests.length, 2);
      assert.notEqual(params(w.requests[0]).payment_link, params(w.requests[1]).payment_link);
      assert.deepEqual(w.links, [params(w.requests[0]).payment_link, params(w.requests[1]).payment_link]);
    });
  });
});

describe("templates with extra variables (product_name) are filled dynamically, or the send is refused", () => {
  const BODY5 = "Hi {{customer_name}}, your {{product_name}} order {{order_number}}: ₹{{amount}} {{payment_link}}";
  const VARS5 = ["customer_name", "product_name", "order_number", "amount", "payment_link"];

  it("a template that needs product_name is sent with the real product name, in the template's own variable order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const tpl = await w.mk("with_product", { body: BODY5, variables: VARS5 });
      const r = await w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.equal(r.whatsapp.sent, true);
      const params = w.requests[0].template.components[0].parameters;
      assert.deepEqual(params.map((p: any) => p.parameter_name), VARS5, "exact order of the template's variables");
      assert.deepEqual(params.map((p: any) => p.text), ["Vishwa", "Herbal Tea", r.order.orderNumber, "449", w.links[0]]);
      assert.ok(params.every((p: any) => typeof p.text === "string" && p.text.trim() !== ""), "no empty / undefined value is ever sent");
    });
  });

  it("several products are listed in the order they were added, each name once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const second = await tx.product.create({ data: { name: "Brain Fuel Capsules", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "100.00" }, select: { id: true } });
      const first = await tx.product.findFirstOrThrow({ where: { name: "Herbal Tea" }, orderBy: { createdAt: "desc" }, select: { id: true } });
      const tpl = await w.mk("with_product", { body: BODY5, variables: VARS5 });
      const r = await w.create({ items: [{ productId: first.id, quantity: 1, unitPrice: "449.00" }, { productId: second.id, quantity: 2, unitPrice: "100.00" }, { productId: first.id, quantity: 1, unitPrice: "449.00" }], sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: tpl.id, whatsappConsent: true });
      assert.equal(r.whatsapp.sent, true);
      assert.equal(params(w.requests[0]).product_name, "Herbal Tea, Brain Fuel Capsules");
    });
  });

  it("an order whose product name cannot be resolved: a clear error, Meta is NOT called, and no message row is written", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const tpl = await w.mk("with_product", { body: BODY5, variables: VARS5 });
      const r = await w.create({ sendPaymentLinkViaWhatsApp: false });
      await tx.orderItem.updateMany({ where: { orderId: r.order.id }, data: { productNameSnapshot: "  " } });
      const result = await notifyPaymentLink(tx, w.as, { leadId: w.lead.id, orderId: r.order.id, normalizedMobile: "+919876543210", orderNumber: r.order.orderNumber, paymentUrl: w.links[0]!, amount: "449.00", currency: "INR", customerName: "Vishwa", templateId: tpl.id }, w.deps);
      assert.equal(result.sent, false);
      assert.equal(result.reason, "Cannot send WhatsApp template: product_name is required but no product name is available for this order.");
      assert.equal(w.requests.length, 0, "Meta was never called");
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: r.order.id } }), 0, "no broken message is stored");
    });
  });

  it("a template that needs a hand-typed value (not something the CRM can fill) is not offered and is refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { conversation: true });
      const manual = await w.mk("needs_manual", { body: "Hi {{customer_name}} {{webinar_name}} {{payment_link}}", variables: ["customer_name", "webinar_name", "payment_link"] });
      const options = await w.svc.getWhatsAppPaymentOptions(w.as, w.lead.id);
      assert.ok(!options.templates.some((t) => t.id === manual.id));
      await assert.rejects(() => w.create({ sendPaymentLinkViaWhatsApp: true, whatsappTemplateId: manual.id, whatsappConsent: true }), (e: any) => e.statusCode === 400 && /webinar_name/.test(e.message));
      assert.deepEqual([await w.ordersFor(), w.requests.length], [0, 0]);
    });
  });
});

describe("template options for the Create Order screen", () => {
  it("lists only approved Meta templates that carry {{payment_link}}, default first, with safe metadata and the customer's consent state", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { consent: "OPTED_IN" });
      const def = await w.mk("zz_other");
      await w.mk("pending_tpl", { status: "PENDING" });
      await w.mk("no_link", { variables: ["customer_name"], body: "Hi {{customer_name}}" });
      await w.mk("gs", { provider: "GUPSHUP" });
      // The real synced prepaid_template (if this DB has it) is switched back on for this check: it must be the default and listed first.
      const prepaid = await tx.whatsAppTemplate.updateMany({ where: { name: "prepaid_template", provider: "META", status: "DISABLED" }, data: { status: "APPROVED" } });
      const o = await w.svc.getWhatsAppPaymentOptions(w.as, w.lead.id);
      assert.deepEqual([o.consent, o.hasWhatsAppNumber], ["OPTED_IN", true]);
      assert.ok(o.templates.some((t) => t.id === def.id));
      assert.ok(o.templates.every((t) => t.provider === "META" && t.usableForPaymentLink && t.variables.includes("payment_link")));
      assert.ok(!o.templates.some((t) => /pending_tpl|no_link|^gs_/.test(t.name)));
      assert.deepEqual(Object.keys(o.templates[0]!).sort(), ["category", "id", "isDefault", "language", "name", "provider", "usableForPaymentLink", "variables"]);
      if (prepaid.count > 0) assert.deepEqual([o.templates[0]!.name, o.templates[0]!.isDefault], ["prepaid_template", true], "prepaid_template is the default and comes first");
    });
  });
  it("no number / nothing recorded reads as such; out-of-scope customers are not found", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { mobile: null });
      const o = await w.svc.getWhatsAppPaymentOptions(w.as, w.lead.id);
      assert.deepEqual([o.consent, o.hasWhatsAppNumber], [null, false]);
      const sales = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      await assert.rejects(() => w.svc.getWhatsAppPaymentOptions({ id: sales.id, email: sales.email, role: Role.SALESPERSON }, w.lead.id), (e: any) => e.statusCode === 404);
    });
  });
});
