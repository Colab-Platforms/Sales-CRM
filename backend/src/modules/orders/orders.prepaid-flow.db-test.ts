// End-to-end prepaid flow (createManualOrder -> real CashfreePaymentsService -> real provider-aware notify), with EVERY
// external system faked: Cashfree API, Shopify client, Meta sender, template sender. Nothing leaves the process and no
// credential is needed. Every test runs in ONE transaction that is always rolled back. Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma, WhatsAppProviderName } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { ProviderHttpError, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import { CashfreeClient, type CashfreeLink } from "../cashfree/cashfree.client.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import WhatsAppFreeTextService from "../whatsapp/whatsapp.freetext.service.js";
import type WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import type { MetaCloudApiProvider } from "../whatsapp/whatsapp.meta.provider.js";
import { notifyOrderConfirmation, notifyPaymentLink } from "../whatsapp/whatsapp.order-notify.service.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });
const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 3_600_000;
// Deliberately distinctive: if either ever shows up in an output, a test below fails.
const SECRET = "cfsk_ma_test_SUPERSECRET0123456789";
const CLIENT_ID = "CFID_TEST_ABC123";
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: CLIENT_ID, CASHFREE_CLIENT_SECRET: SECRET, PUBLIC_BACKEND_URL: "https://crm.example.com" });

function fakeCashfree(over: Partial<CashfreeApi> = {}) {
  const calls = { create: [] as { request: Parameters<CashfreeApi["createLink"]>[0]; key: string }[], cancel: [] as string[] };
  const link = (linkId: string, status = "ACTIVE"): CashfreeLink => ({ cfLinkId: "1", linkId, linkStatus: status, linkUrl: `https://pay.test/${linkId}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null });
  const api: CashfreeApi = {
    createLink: async (request, key) => { calls.create.push({ request, key }); return link(request.link_id); },
    getLink: async (linkId) => link(linkId),
    cancelLink: async (linkId) => { calls.cancel.push(linkId); return link(linkId, "CANCELLED"); },
    ...over,
  };
  return { api, calls };
}

function shopify(): ShopifyClient {
  let n = 0;
  return { query: async (doc: string) => (doc.includes("orderCancel") ? { orderCancel: { job: { id: "1", done: true }, orderCancelUserErrors: [] } } : { orderCreate: { order: { id: `gid://shopify/Order/${uid()}-${++n}`, name: `#T${n}` }, userErrors: [] } }) } as unknown as ShopifyClient;
}

interface Setup { provider: WhatsAppProviderName; windowOpen?: boolean; templates?: { provider: WhatsAppProviderName; variables: string[]; status?: "APPROVED" | "PENDING" }[]; metaThrows?: boolean }

async function setup(tx: Db, runner: TxRunner, s: Setup, apiOver: Partial<CashfreeApi> = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9000000123", normalizedMobile: "+919000000123", email: "priya@zz.invalid" }, select: { id: true } });
  await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: s.provider } });
  await tx.whatsAppMessage.create({ data: { provider: s.provider, providerMessageId: `in-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId: lead.id, fromNumber: "919000000123", normalizedContact: "+919000000123", body: "hi", createdAt: new Date(NOW.getTime() - (s.windowOpen === false ? 30 : 1) * HOUR), receivedAt: new Date(NOW.getTime() - (s.windowOpen === false ? 30 : 1) * HOUR) } });
  const templateIds: string[] = [];
  for (const t of s.templates ?? []) {
    const row = await tx.whatsAppTemplate.create({ data: { name: `zz_${uid()}`, provider: t.provider, language: "en", body: "x {{payment_link}}", variables: t.variables, status: t.status ?? "APPROVED" }, select: { id: true } });
    templateIds.push(row.id);
  }
  const product = await tx.product.create({ data: { name: "Herbal Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "1199.00" }, select: { id: true } });

  const cf = fakeCashfree(apiOver);
  const sentTexts: string[] = [];
  const templateSends: { templateId: string; orderId?: string }[] = [];
  const meta = { async sendText(input: { body: string }) { if (s.metaThrows) throw new Error("Meta rejected the message (HTTP 400)"); sentTexts.push(input.body); return { providerMessageId: `wamid.${uid()}`, raw: {} }; } } as unknown as MetaCloudApiProvider;
  const freeText = new WhatsAppFreeTextService(tx, async () => meta, () => NOW);
  const messaging = { sendTemplate: async (_u: unknown, input: { templateId: string; orderId?: string }) => { templateSends.push(input); return { status: "SENT" } as never; } } as unknown as WhatsAppMessagingService;
  const cashfreeSvc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => cf.api, now: () => NOW, notifyDeps: { freeText, messaging } });
  const orders = new OrdersService(tx, () => shopify(), () => cashfreeSvc, {
    confirmation: (db, u, p) => notifyOrderConfirmation(db, u, p, { freeText, messaging }),
    paymentLink: (db, u, p) => notifyPaymentLink(db, u, p, { freeText, messaging }),
  });
  const create = (extra: Partial<Prisma.OrderUncheckedCreateInput> & { paymentMethod?: "COD" | "PAYMENT_LINK"; idempotencyKey?: string } = {}) =>
    orders.createManualOrder(as(admin, Role.ADMIN), { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "1199.00" }], paymentMethod: extra.paymentMethod ?? "PAYMENT_LINK", idempotencyKey: extra.idempotencyKey });
  return { admin, lead, cf, sentTexts, templateSends, templateIds, cashfreeSvc, orders, create };
}

describe("prepaid order -> Cashfree link -> WhatsApp (Meta, window open)", () => {
  it("creates one link for the exact amount/customer, saves it on ONE payment row, and sends the customer the real URL", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META" });
      const r = await t.create();

      // Cashfree request
      assert.equal(t.cf.calls.create.length, 1);
      const req = t.cf.calls.create[0]!.request;
      assert.equal(req.link_amount, 1199, "exact final amount");
      assert.equal(req.customer_details.customer_phone, "9000000123", "the customer's own phone");
      assert.equal(req.customer_details.customer_email, "priya@zz.invalid");
      assert.equal(req.customer_details.customer_name, "Priya Shah");
      assert.equal(req.link_notes.crm_order, r.order.orderNumber, "the exact CRM order reference");
      assert.ok(req.link_purpose.includes(r.order.orderNumber));
      assert.equal(req.link_meta?.notify_url, "https://crm.example.com/api/webhooks/cashfree", "the existing callback configuration");

      // Persisted through the existing Payment structure - one row, no duplicate
      const payments = await tx.payment.findMany({ where: { orderId: r.order.id } });
      assert.equal(payments.length, 1);
      assert.equal(payments[0]!.method, "PAYMENT_LINK");
      assert.equal(payments[0]!.status, "PENDING");
      assert.equal(payments[0]!.externalSource, "CASHFREE");
      assert.ok(payments[0]!.externalId && payments[0]!.providerOrderId);
      const url = `https://pay.test/${payments[0]!.externalId}`;
      assert.equal(payments[0]!.paymentUrl, url);
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(r.paymentLink?.paymentUrl, url);
      assert.equal(r.shopify.status, "created");

      // WhatsApp: free text with order number, amount and the ACTUAL URL
      assert.equal(t.sentTexts.length, 1);
      assert.ok(t.sentTexts[0]!.includes(url), "the actual Cashfree URL");
      assert.ok(t.sentTexts[0]!.includes(r.order.orderNumber), "the order number");
      const text = t.sentTexts[0]!;
      assert.ok(text.startsWith("Hi Priya 👋"), "greets the customer by name");
      assert.ok(text.includes("• Herbal Tea × 1"), "the real product name and quantity");
      assert.ok(text.includes("Total: ₹1,199"), "the payable amount");
      assert.ok(text.includes("Payment: Pending") && text.includes("Ayush Wellness"));
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text), false, "no internal ids in the customer message");
      assert.ok(text.split("\n").includes(url), "the payment URL is a whole, untouched line");
      assert.deepEqual(r.whatsapp, { sent: true, via: "FREE_TEXT", provider: "META" });
      const msg = await tx.whatsAppMessage.findFirstOrThrow({ where: { orderId: r.order.id, direction: "OUTBOUND" }, select: { provider: true, toNumber: true } });
      assert.deepEqual(msg, { provider: "META", toNumber: "+919000000123" });

      // Remembered on the order (safe: no URL) and returned by the order detail
      assert.equal(r.order.whatsappNotification?.sent, true);
      assert.equal(JSON.stringify(await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).includes(url), false, "the URL is never copied into order metadata");
    });
  });

  it("a double submit (same idempotency key) creates one CRM order, one Cashfree link, one WhatsApp message", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META" });
      const key = `k-${uid()}`;
      const [a, b] = await Promise.all([t.create({ idempotencyKey: key }), t.create({ idempotencyKey: key })]);
      assert.equal(a.order.id, b.order.id);
      assert.equal(t.cf.calls.create.length, 1);
      assert.equal(t.sentTexts.length, 1);
    });
  });

  it("an existing active link is reused (no second Cashfree link, no second payment row)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META" });
      const r = await t.create();
      const again = await t.cashfreeSvc.createPaymentLink(as(t.admin, Role.ADMIN), r.order.id);
      assert.equal(again.reused, true);
      assert.equal(again.paymentUrl, r.paymentLink?.paymentUrl);
      assert.equal(t.cf.calls.create.length, 1);
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id } }), 1);
    });
  });

  it("a WhatsApp failure never invalidates the link: it stays saved and usable, and the reason is safe and remembered", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META", metaThrows: true });
      const r = await t.create();
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(r.whatsapp.sent, false);
      assert.match(r.whatsapp.reason ?? "", /Meta rejected the message/);
      const p = await tx.payment.findFirstOrThrow({ where: { orderId: r.order.id } });
      assert.equal(p.status, "PENDING");
      assert.ok(p.paymentUrl, "the link is still on the order page");
      assert.equal(r.order.whatsappNotification?.sent, false);
    });
  });

  it("retrying just the WhatsApp step later (order page) sends the SAME link - no new Cashfree link", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META", metaThrows: true });
      const r = await t.create();
      assert.equal(r.whatsapp.sent, false);
      // Meta recovers; the salesperson clicks "Send on WhatsApp" (provider-aware, no template chosen)
      const svc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => t.cf.api, now: () => NOW, notifyDeps: { freeText: new WhatsAppFreeTextService(tx, async () => ({ async sendText(i: { body: string }) { t.sentTexts.push(i.body); return { providerMessageId: "w", raw: {} }; } }) as unknown as MetaCloudApiProvider, () => NOW) } });
      const payment = await tx.payment.findFirstOrThrow({ where: { orderId: r.order.id }, select: { id: true, paymentUrl: true } });
      const sent = await svc.sendPaymentLinkAuto(as(t.admin, Role.ADMIN), payment.id);
      assert.equal(sent.sent, true);
      assert.ok(t.sentTexts.at(-1)!.includes(payment.paymentUrl!));
      assert.equal(t.cf.calls.create.length, 1, "no additional Cashfree link");
      const detail = await t.orders.getOrder(as(t.admin, Role.ADMIN), r.order.id);
      assert.equal(detail.whatsappNotification?.sent, true, "the order page now shows Sent");
    });
  });
});

describe("prepaid order - Meta window closed, and AiSensy/Gupshup", () => {
  it("Meta, window closed: never free text; uses an APPROVED META template that carries {{payment_link}}", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META", windowOpen: false, templates: [{ provider: "META", variables: ["payment_link"], status: "PENDING" }, { provider: "META", variables: ["customer_name"] }, { provider: "META", variables: ["payment_link"] }] });
      const r = await t.create();
      assert.equal(t.sentTexts.length, 0, "no unauthorized free text outside the 24-hour window");
      assert.equal(t.templateSends.length, 1);
      assert.equal(t.templateSends[0]!.templateId, t.templateIds[2], "the approved template that has the payment_link variable - not the pending or the wrong-variable one");
      assert.equal(t.templateSends[0]!.orderId, r.order.id);
      assert.deepEqual(r.whatsapp, { sent: true, via: "TEMPLATE", provider: "META" });
    });
  });

  it("Meta, window closed, NO suitable approved template: link is created, WhatsApp is 'not sent' with a clear reason", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META", windowOpen: false, templates: [{ provider: "META", variables: ["payment_link"], status: "PENDING" }] });
      const r = await t.create();
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(r.whatsapp.sent, false);
      assert.match(r.whatsapp.reason ?? "", /24-hour WhatsApp window is closed and no approved Meta template/);
      assert.equal(t.sentTexts.length + t.templateSends.length, 0);
    });
  });

  for (const provider of ["AISENSY", "GUPSHUP"] as const) {
    it(`${provider} conversation: template-only through ${provider}'s own template - never Meta free text, never another provider's template`, async () => {
      await inRollback(async (tx, runner) => {
        const t = await setup(tx, runner, { provider, templates: [{ provider: "META", variables: ["payment_link"] }, { provider, variables: ["payment_link"] }] });
        const r = await t.create();
        assert.equal(t.sentTexts.length, 0);
        assert.equal(t.templateSends.length, 1);
        assert.equal(t.templateSends[0]!.templateId, t.templateIds[1]);
        assert.equal(r.whatsapp.provider, provider);
      });
    });
  }
});

describe("prepaid order - Cashfree failure and retry", () => {
  it("a Cashfree rejection does not roll back the order; Shopify stays created; WhatsApp says the link is unavailable", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META" }, { createLink: async () => { throw new ProviderHttpError("CASHFREE", 400, "Cashfree rejected the request", false); } });
      const r = await t.create();
      assert.equal(r.order.status, "PENDING_PAYMENT");
      assert.equal(await tx.order.count({ where: { leadId: t.lead.id } }), 1);
      assert.equal(r.shopify.status, "created");
      assert.equal(r.paymentLink?.status, "failed");
      assert.match(r.paymentLink?.reason ?? "", /Cashfree rejected the payment link/);
      assert.equal(r.whatsapp.sent, false);
      assert.match(r.whatsapp.reason ?? "", /Payment link unavailable/);
      assert.equal(t.sentTexts.length, 0);
    });
  });

  it("retry after a failure (order page 'Create payment link') creates exactly one open link, and a second retry reuses it", async () => {
    await inRollback(async (tx, runner) => {
      let failFirst = true;
      const t = await setup(tx, runner, { provider: "META" }, { createLink: async (request) => { if (failFirst) { failFirst = false; throw new ProviderHttpError("CASHFREE", 400, "Cashfree rejected the request", false); } return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${request.link_id}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }; } });
      const r = await t.create();
      assert.equal(r.paymentLink?.status, "failed");

      const retry = await t.cashfreeSvc.createPaymentLink(as(t.admin, Role.ADMIN), r.order.id);
      const again = await t.cashfreeSvc.createPaymentLink(as(t.admin, Role.ADMIN), r.order.id);
      assert.equal(retry.reused, false);
      assert.equal(again.reused, true);
      assert.equal(again.paymentId, retry.paymentId, "same link, no duplicate");
      const open = await tx.payment.count({ where: { orderId: r.order.id, status: "PENDING", externalSource: "CASHFREE" } });
      assert.equal(open, 1);
    });
  });
});

describe("COD stays unchanged, cancellation and secrets", () => {
  it("COD never touches Cashfree and still sends the existing confirmation", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META" });
      const r = await t.create({ paymentMethod: "COD" });
      assert.equal(t.cf.calls.create.length, 0);
      assert.equal(r.paymentLink, null);
      assert.equal(r.order.status, "CONFIRMED");
      assert.equal(r.whatsapp.via, "FREE_TEXT");
      assert.ok(t.sentTexts[0]!.includes("Cash on Delivery"));
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id, method: "COD" } }), 1);
    });
  });

  it("cancelling an unpaid prepaid order cancels the link at Cashfree (real service); a PAID one is left alone", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { provider: "META" });
      const unpaid = await t.create();
      const c1 = await t.orders.cancelOrder(as(t.admin, Role.ADMIN), unpaid.order.id, {});
      assert.equal(c1.paymentLink.status, "cancelled");
      assert.equal(t.cf.calls.cancel.length, 1);

      const paid = await t.create();
      await tx.payment.updateMany({ where: { orderId: paid.order.id }, data: { status: "SUCCESS", paidAt: NOW } });
      const c2 = await t.orders.cancelOrder(as(t.admin, Role.ADMIN), paid.order.id, {});
      assert.equal(c2.paymentLink.status, "paid");
      assert.equal(t.cf.calls.cancel.length, 1, "no Cashfree cancellation for a successful payment");
      const p = await tx.payment.findFirstOrThrow({ where: { orderId: paid.order.id } });
      assert.deepEqual([p.status, p.refundedAt, p.refundedAmount], ["SUCCESS", null, null]);
    });
  });

  it("no credential ever appears in the API results, order detail, activities, stored payment metadata or errors", async () => {
    await inRollback(async (tx, runner) => {
      const ok = await setup(tx, runner, { provider: "META" });
      const r = await ok.create();
      // The REAL client + sanitiser: Cashfree answers 401 and (worst case) echoes the key back in its error text.
      const echoing = new CashfreeClient(CONFIG, (async () => new Response(JSON.stringify({ message: `authentication failed for key ${SECRET}` }), { status: 401 })) as unknown as typeof fetch);
      const rejected = await setup(tx, runner, { provider: "META" }, { createLink: (request, key) => echoing.createLink(request, key) });
      const bad = await rejected.create();
      const dump = JSON.stringify({ r, bad, activities: await tx.activity.findMany({ where: { orderId: { in: [r.order.id, bad.order.id] } }, select: { title: true, description: true, metadata: true, newValue: true } }), payments: await tx.payment.findMany({ where: { orderId: { in: [r.order.id, bad.order.id] } }, select: { metadata: true, failureReason: true } }), orders: await tx.order.findMany({ where: { id: { in: [r.order.id, bad.order.id] } }, select: { metadata: true } }), texts: ok.sentTexts });
      assert.equal(dump.includes(SECRET), false, "the Cashfree secret must not appear anywhere");
      assert.equal(dump.includes("SUPERSECRET"), false);
      assert.equal(dump.includes(CLIENT_ID), false, "nor the client id");
      assert.equal(bad.paymentLink?.status, "failed");
    });
  });
});
