// Local manual-test harness for the dynamic UPI QR. Run through start-mock.ps1 (isolated database + SIMULATED Cashfree). Commands:
//   seed                       a synthetic prepaid order through the real order service; the QR is requested (against the simulated Cashfree) and "sent" to a fake WhatsApp that only saves the image to a file
//   status                     the order / payment / QR / exceptions / simulated Cashfree calls
//   pay qr|link [paymentId]    SIMULATE a customer paying through the QR or the link: the simulated Cashfree reports it paid and a correctly SIGNED webhook is posted to the local server
//   cancel [paymentId]         cancel the payment link through the real service (closes the QR order at the simulated Cashfree) and mark the order CANCELLED
// Nothing here is real: no Cashfree order, QR or payment exists, and no WhatsApp message is sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../../src/lib/prisma.js";
import OrdersService from "../../src/modules/orders/orders.service.js";
import CashfreePaymentsService from "../../src/modules/cashfree/cashfree.payments.service.js";
import { CashfreeClient } from "../../src/modules/cashfree/cashfree.client.js";
import { loadCashfreeConfig } from "../../src/modules/cashfree/cashfree.config.js";
import { computeSignature } from "../../src/modules/cashfree/cashfree.hmac.js";
import { qrOrderIdFor } from "../../src/modules/cashfree/cashfree.upi-qr.js";
import { hashPassword } from "../../src/lib/password.js";
import { sendPaymentQr } from "../../src/modules/whatsapp/whatsapp.payment-qr.js";
import { ProductType, OrderStatus } from "../../generated/prisma/enums.js";

const STATE = process.env.MOCK_CF_STATE!;
const PORT = process.env.PORT ?? "5100";
const dir = path.dirname(STATE);
const load = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const save = (s: unknown) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();

async function admin() {
  const user = await prisma.user.findFirst({ where: { username: "test.admin" }, select: { id: true, username: true, role: true } });
  if (!user) throw new Error("The synthetic user test.admin is not in the isolated database");
  return user;
}

async function seed() {
  const as = await admin();
  const config = loadCashfreeConfig();
  const product = (await prisma.product.findFirst({ where: { name: "SIMULATED Herbal Masala" }, select: { id: true } })) ?? (await prisma.product.create({ data: { name: "SIMULATED Herbal Masala", type: ProductType.PRODUCT, sku: `SIM-${uid()}`, basePrice: "649.00" }, select: { id: true } }));
  const tag = uid();
  const lead = await prisma.lead.create({ data: { leadNumber: `SIM-${tag}`, firstName: "SIMULATED", lastName: "Customer", mobile: "9000000000", normalizedMobile: "+919000000000", ownerId: as.id }, select: { id: true } });

  let n = 0;
  const fakeProvider = {
    uploadMedia: async (data: Buffer) => { const file = path.join(dir, `simulated-whatsapp-image-${Date.now()}-${++n}.png`); fs.writeFileSync(file, data); console.log(`  [SIMULATED WhatsApp] image saved to ${file} (nothing was sent to anyone)`); return `SIM-MEDIA-${n}`; },
    sendImage: async (input: { caption?: string }) => { console.log(`  [SIMULATED WhatsApp] image "sent": ${input.caption}`); return { providerMessageId: `sim.wamid.${Date.now()}.${n}`, raw: {} }; },
  };
  const freeText = { getCapability: async () => ({ capability: { freeText: { allowed: true, reason: null, message: null } }, meta: fakeProvider }) } as never;
  const qrDeps = { freeText, publicBaseUrl: "https://mock.sandbox.example.com", upiQr: { runner: prisma, api: new CashfreeClient(config), config, env: process.env } };
  const notify = {
    confirmation: async () => ({ sent: true, via: "FREE_TEXT" as const, provider: "META" as const }),
    paymentLink: async () => ({ sent: true, via: "FREE_TEXT" as const, provider: "META" as const }),
    paymentQr: (db: never, user: never, paymentId: string) => sendPaymentQr(db, user, paymentId, qrDeps as never),
  } as never;
  const orders = new OrdersService(prisma as never, () => { throw new Error("Shopify is not available in the simulated test"); }, () => new CashfreePaymentsService(prisma) as never, notify);
  const address = { name: "SIMULATED Customer", line1: "1 Test Street", city: "Pune", state: "Maharashtra", pincode: "411001", phone: "9000000000" };
  const r = await orders.createManualOrder(as as never, { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "649.00" }], paymentMethod: "PAYMENT_LINK", discount: { type: "FIXED", value: "50" }, shippingAddress: address, shippingPincode: "411001" } as never);
  console.log(`SEEDED (synthetic): order ${r.order.orderNumber}  id ${r.order.id}`);
  console.log(`  QR step result: ${JSON.stringify((r as { whatsapp?: { qr?: unknown } }).whatsapp?.qr ?? null)}`);
  await status(r.order.id);
}

async function paymentFor(arg?: string) {
  const where = arg ? { id: arg } : { externalSource: "CASHFREE", order: { lead: { leadNumber: { startsWith: "SIM-" } } } };
  const p = await prisma.payment.findFirst({ where, orderBy: { createdAt: "desc" }, select: { id: true, orderId: true, amount: true, currency: true, status: true, externalId: true, order: { select: { orderNumber: true } } } });
  if (!p) throw new Error("No simulated payment found - run: seed");
  return p;
}

async function status(orderId?: string) {
  const p = await paymentFor();
  const oid = orderId ?? p.orderId;
  const order = await prisma.order.findUniqueOrThrow({ where: { id: oid }, select: { orderNumber: true, status: true, totalAmount: true, currency: true, metadata: true } });
  const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: oid, externalSource: "CASHFREE" }, select: { id: true, status: true, amount: true, currency: true, paymentUrl: true, providerPaymentId: true, metadata: true } });
  const meta = (pay.metadata ?? {}) as { upiQr?: { orderId?: string; amount?: string; currency?: string; closed?: unknown } };
  const exceptions = ((order.metadata ?? {}) as { paymentExceptions?: unknown[] }).paymentExceptions ?? [];
  console.log(JSON.stringify({
    order: { number: order.orderNumber, id: oid, status: order.status, total: `${order.totalAmount} ${order.currency}` },
    payment: { id: pay.id, status: pay.status, amount: `${pay.amount} ${pay.currency}`, paymentLinkStillAvailable: Boolean(pay.paymentUrl), providerPaymentId: pay.providerPaymentId },
    dynamicQr: meta.upiQr ? { cashfreeOrder: meta.upiQr.orderId, amount: `${meta.upiQr.amount} ${meta.upiQr.currency}`, closed: meta.upiQr.closed ?? null } : null,
    paymentExceptions: exceptions,
    paymentStatusChangeRows: await prisma.activity.count({ where: { orderId: oid, type: "PAYMENT_STATUS_CHANGED" } }),
    simulatedCashfreeCalls: load().log,
  }, null, 2));
}

async function pay(kind: string, arg?: string) {
  const p = await paymentFor(arg);
  const amount = Number(p.amount.toString());
  const s = load();
  let orderId: string;
  if (kind === "qr") {
    orderId = qrOrderIdFor(p.id);
    s.control.qrPaid = { orderId, cfPaymentId: "SIM-PAY-QR", amount };
  } else {
    orderId = `CFPay_${String(p.externalId).slice(-16)}_b3ea_1791374485548`;
    s.control.linkPaid = { linkId: p.externalId, orderId, cfPaymentId: "SIM-PAY-LINK", amount };
  }
  save(s);
  const cfPaymentId = kind === "qr" ? "SIM-PAY-QR" : "SIM-PAY-LINK";
  const payload = { type: "PAYMENT_SUCCESS_WEBHOOK", event_time: new Date().toISOString(), data: { order: { order_id: orderId, order_amount: amount, order_currency: "INR" }, payment: { cf_payment_id: cfPaymentId, payment_status: "SUCCESS", payment_amount: amount, payment_currency: "INR", payment_group: "upi", bank_reference: "SIMULATED-UTR", payment_time: new Date().toISOString() }, customer_details: {} } };
  const raw = Buffer.from(JSON.stringify(payload));
  const ts = String(Date.now());
  const res = await fetch(`http://127.0.0.1:${PORT}/api/webhooks/cashfree`, { method: "POST", headers: { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature": computeSignature(ts, raw, process.env.CASHFREE_CLIENT_SECRET!), "x-idempotency-key": `sim-${Date.now()}-${Math.random()}` }, body: raw });
  console.log(`SIMULATED ${kind.toUpperCase()} payment webhook (signed, local server): HTTP ${res.status}`);
  await new Promise((r) => setTimeout(r, 2500));
  await status();
}

async function cancel(arg?: string) {
  const p = await paymentFor(arg);
  const as = await admin();
  await new CashfreePaymentsService(prisma).cancelPaymentLink(as as never, p.id);
  await prisma.order.update({ where: { id: p.orderId }, data: { status: OrderStatus.CANCELLED } });
  console.log("Payment link cancelled through the real service (the QR order is closed at the SIMULATED Cashfree); order marked CANCELLED (simulated cancellation)");
  await status();
}

// the synthetic isolated-database login used for this manual test (not a real account)
const TEST_PASSWORD = "SimulatedTest#2026";
async function setpw() {
  await prisma.user.update({ where: { username: "test.admin" }, data: { passwordHash: await hashPassword(TEST_PASSWORD) } });
  console.log(`Isolated-database login: test.admin / ${TEST_PASSWORD}  (synthetic; exists only in crm_iso)`);
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === "seed") await seed();
  else if (cmd === "setpw") await setpw();
  else if (cmd === "status") await status();
  else if (cmd === "pay" && (a === "qr" || a === "link")) await pay(a, b);
  else if (cmd === "cancel") await cancel(a);
  else console.log("usage: seed | status | pay qr|link [paymentId] | cancel [paymentId]");
} finally {
  await prisma.$disconnect();
}
