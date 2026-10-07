// Prepaid Upgrade: "Send on WhatsApp" through the EXISTING payment-link sender (CashfreePaymentsService.sendPaymentLinkAuto ->
// notifyPaymentLink -> the provider-aware free-text/template path). Meta and Cashfree are faked; nothing leaves the process.
// Every test runs in ONE transaction that is always rolled back. Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import { type Db, type TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import WhatsAppFreeTextService from "../whatsapp/whatsapp.freetext.service.js";
import type WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import type { MetaCloudApiProvider } from "../whatsapp/whatsapp.meta.provider.js";
import { buildPaymentLinkMessage } from "../whatsapp/whatsapp.order-message.js";
import { derivePaymentMode } from "./orders.filters.js";
import PrepaidUpgradeService from "./orders.prepaid-upgrade.service.js";

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
const NOW = new Date("2026-10-05T12:00:00.000Z");
const HOUR = 3_600_000;
const CF_CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "CFID_TEST", CASHFREE_CLIENT_SECRET: "cfsk_ma_test_SECRET0123456789", PUBLIC_BACKEND_URL: "https://crm.example.com" });

async function setup(tx: Db, runner: TxRunner, opts: { products?: { name: string; variant?: string; qty?: number }[]; metaThrows?: boolean; total?: string } = {}) {
  const total = opts.total ?? "699.00";
  const tele = await tx.user.create({ data: { name: "Tele Caller", username: `t-${uid()}`, role: Role.SALESPERSON } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Pawa", lastName: "Kumar", mobile: "9000000123", normalizedMobile: "+919000000123", email: "p@zz.invalid", ownerId: tele.id }, select: { id: true } });
  await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: "META" } });
  await tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `in-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId: lead.id, fromNumber: "919000000123", normalizedContact: "+919000000123", body: "hi", createdAt: new Date(NOW.getTime() - HOUR), receivedAt: new Date(NOW.getTime() - HOUR) } });
  const order = await tx.order.create({
    data: {
      orderNumber: `ORD-${uid()}`, leadId: lead.id, createdById: tele.id, source: "SALESPERSON", status: "CONFIRMED", subtotal: total, totalAmount: total, discountAmount: "0",
      metadata: { paymentMode: "COD" }, payments: { create: { amount: total, currency: "INR", method: "COD", status: "PENDING" } },
    },
    select: { id: true },
  });
  for (const p of opts.products ?? [{ name: "Aayush Wellness Herbal Masala" }]) {
    await tx.orderItem.create({ data: { orderId: order.id, productNameSnapshot: p.name, variantNameSnapshot: p.variant ?? null, quantity: p.qty ?? 1, unitPrice: total, discountAmount: "0", taxAmount: "0", totalPrice: total } });
  }
  const link = (id: string, status = "ACTIVE"): CashfreeLink => ({ cfLinkId: "1", linkId: id, linkStatus: status, linkUrl: `https://pay.test/${id}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null });
  const created: number[] = [];
  const api: CashfreeApi = { createLink: async (r) => { created.push(r.link_amount); return link(r.link_id); }, getLink: async (id) => link(id), cancelLink: async (id) => link(id, "CANCELLED") };
  const sentTexts: string[] = [];
  const meta = { async sendText(input: { body: string }) { if (opts.metaThrows) throw new Error("Meta rejected the message (HTTP 400)"); sentTexts.push(input.body); return { providerMessageId: `wamid.${uid()}`, raw: {} }; } } as unknown as MetaCloudApiProvider;
  const freeText = new WhatsAppFreeTextService(tx, async () => meta, () => NOW);
  const messaging = { sendTemplate: async () => ({ status: "SENT" }) as never } as unknown as WhatsAppMessagingService;
  const cashfree = new CashfreePaymentsService(runner, { config: () => CF_CONFIG, client: () => api, now: () => NOW, notifyDeps: { freeText, messaging } });
  const svc = new PrepaidUpgradeService(tx as never, () => cashfree, () => NOW);
  const user = { id: tele.id, username: tele.username, role: Role.SALESPERSON };
  const offerWithLink = async (discountValue = "100") => {
    const o = await svc.createOffer(user, order.id, { discountType: "FIXED", discountValue });
    return svc.generateLink(user, order.id, o.offer!.id);
  };
  return { order, user, svc, cashfree, sentTexts, created, offerWithLink, tx };
}

describe("Send on WhatsApp for a Prepaid Upgrade link (existing sender, real values)", () => {
  it("sends the customer's real name, the real product, original / discount / payable amounts and the real link", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const r = await t.offerWithLink("100");
      const result = await t.cashfree.sendPaymentLinkAuto(t.user, r.paymentId!);
      assert.equal(result.sent, true);
      assert.equal(result.via, "FREE_TEXT");
      const text = t.sentTexts.at(-1)!;
      assert.ok(text.includes("Hi Pawa Kumar,"), text);
      assert.ok(text.includes("Aayush Wellness Herbal Masala"), "the real product");
      assert.ok(text.includes("Original amount: ₹699"));
      assert.ok(text.includes("Special online payment discount: ₹100"));
      assert.ok(text.includes("Amount to pay: ₹599"));
      assert.ok(text.includes(r.offer!.paymentUrl!), "the exact generated link, untouched");
      assert.ok(text.includes("Pay securely here:"));
      assert.equal(t.created.length, 1, "sending a message never creates another link");
    });
  });
  it("a different discount and a different amount are reflected (nothing hardcoded)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { total: "1249.00" });
      const r = await t.offerWithLink("150");
      await t.cashfree.sendPaymentLinkAuto(t.user, r.paymentId!);
      const text = t.sentTexts.at(-1)!;
      assert.ok(text.includes("Original amount: ₹1,249") && text.includes("discount: ₹150") && text.includes("Amount to pay: ₹1,099"), text);
    });
  });
  it("multiple products are listed by name", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { products: [{ name: "Herbal Masala" }, { name: "Dia Shield Tablets", variant: "Pack Of 3" }] });
      const r = await t.offerWithLink();
      await t.cashfree.sendPaymentLinkAuto(t.user, r.paymentId!);
      const text = t.sentTexts.at(-1)!;
      assert.ok(text.includes("special discount for your order") && text.includes("• Herbal Masala") && text.includes("• Dia Shield Tablets (Pack Of 3)"), text);
    });
  });
  it("a failed WhatsApp send reports why, and the payment link stays valid: same link, still PAYMENT_PENDING, order still COD, no new link", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner, { metaThrows: true });
      const r = await t.offerWithLink();
      const result = await t.cashfree.sendPaymentLinkAuto(t.user, r.paymentId!);
      assert.equal(result.sent, false);
      assert.ok(result.reason);
      const view = await t.svc.getUpgrade(t.user, t.order.id);
      assert.equal(view.offer!.status, "PAYMENT_PENDING");
      assert.equal(view.offer!.paymentUrl, r.offer!.paymentUrl);
      assert.equal(t.created.length, 1);
      const o = await tx.order.findUniqueOrThrow({ where: { id: t.order.id }, select: { totalAmount: true, payments: { select: { method: true, status: true, externalSource: true } } } });
      assert.equal(derivePaymentMode(o.payments), "COD");
      assert.equal(Number(o.totalAmount), 699);
      const open = o.payments.filter((p) => p.externalSource === "CASHFREE" && p.status === "PENDING");
      assert.equal(open.length, 1, "the link is still the one open payment");
    });
  });
  it("an ordinary (non-upgrade) payment link message is unchanged", () => {
    const text = buildPaymentLinkMessage({ customerName: "Pawa Kumar", orderNumber: "SHP-1", items: [{ name: "Herbal Masala", quantity: 1 }], amount: "699", currency: "INR", paymentUrl: "https://pay.test/x" });
    assert.ok(text.startsWith("Payment Link for Your Order") && text.includes("Total: ₹699") && !text.includes("discount"));
  });
});
