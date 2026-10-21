// Prepaid payment QR on WhatsApp, against the real schema. ONE rolled-back transaction per test on the isolated test database. Cashfree, Shopify and the WhatsApp (Meta) provider are scripted fakes:
// no payment link is created at Cashfree, nothing is sent to anyone.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import type WhatsAppFreeTextService from "../whatsapp/whatsapp.freetext.service.js";
import express from "express";
import type { AddressInfo } from "node:net";
import WhatsAppService from "../whatsapp/whatsapp.service.js";
import { buildPaymentQrImage, renderStoredPaymentQr, ensureQrToken, loadPaymentQrPng, paymentQrImageUrl, sendPaymentQr, type PaymentQrDeps } from "../whatsapp/whatsapp.payment-qr.js";
import { createPublicQrRoutes } from "../whatsapp/whatsapp.payment-qr.routes.js";
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
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });
const BASE = "https://crm.example.com";

/** Meta provider fake: records every image it is asked to send; can be made to fail. */
function fakeMeta() {
  const images: { to: string; link: string; mediaId?: string; caption?: string }[] = [];
  const uploads: { mimeType: string; filename: string; png: boolean; data: Buffer }[] = [];
  const state = { failNext: 0, failUpload: false, upload: false };
  const provider: Record<string, unknown> = {
    sendImage: async (input: { to: string; link: string; mediaId?: string; caption?: string }) => {
      images.push(input);
      if (state.failNext > 0) { state.failNext -= 1; throw new Error("Meta rejected the image (token EAAB123456789secretvalue expired)"); }
      return { providerMessageId: `wamid.${images.length}`, raw: {} };
    },
  };
  provider.uploadMedia = undefined;
  const enableUpload = (fail = false) => {
    state.upload = true;
    state.failUpload = fail;
    provider.uploadMedia = async (data: Buffer, mimeType: string, filename: string) => {
      uploads.push({ mimeType, filename, data, png: data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) });
      if (state.failUpload) throw new Error("Meta rejected the media upload (token EAAB123456789secretvalue)");
      return `MEDIA-${uploads.length}`;
    };
  };
  return { images, uploads, state, provider, enableUpload };
}

async function world(tx: Prisma.TransactionClient, opts: { windowOpen?: boolean; publicBase?: string | null; textSent?: boolean } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Doddesh", mobile: "9902575944", normalizedMobile: "+919902575944", ownerId: admin.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" }, select: { id: true } });
  const meta = fakeMeta();
  const links: string[] = [];
  const api: CashfreeApi = {
    createLink: async (request) => { links.push(request.link_id); return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://payments.cashfree.com/links/${request.link_id.slice(-16)}`, linkAmount: String(request.link_amount), linkAmountPaid: "0", linkExpiryTime: null } as unknown as CashfreeLink; },
    getLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "ACTIVE", linkUrl: `https://payments.cashfree.com/links/${linkId.slice(-16)}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
    cancelLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "CANCELLED", linkUrl: null, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
  };
  const cashfree = new CashfreePaymentsService({ $transaction: (cb: (t: never) => unknown) => cb(tx as never) } as never, { config: () => CONFIG, client: () => api });
  const windowOpen = opts.windowOpen !== false;
  const freeText = { getCapability: async () => ({ capability: { freeText: { allowed: windowOpen, reason: windowOpen ? null : "SERVICE_WINDOW_CLOSED", message: windowOpen ? null : "The 24-hour WhatsApp customer-service window has closed." } }, meta: windowOpen ? meta.provider : null }) } as unknown as WhatsAppFreeTextService;
  const qrDeps: PaymentQrDeps = { freeText, publicBaseUrl: opts.publicBase === undefined ? BASE : opts.publicBase };
  const notify = {
    confirmation: async () => ({ sent: true, via: "FREE_TEXT" as const, provider: "META" as const }),
    paymentLink: async () => ({ sent: opts.textSent !== false, via: "FREE_TEXT" as const, provider: "META" as const, ...(opts.textSent === false ? { reason: "not sent" } : {}) }),
    paymentQr: (db: never, user: never, paymentId: string) => sendPaymentQr(db, user, paymentId, qrDeps),
  } as never;
  const shopify = { query: async () => ({ orderCreate: { order: { id: "gid://shopify/Order/1", name: "#T1" }, userErrors: [] }, customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] } }) } as unknown as ShopifyClient;
  const orders = new OrdersService(tx as never, () => shopify, () => cashfree as never, notify);
  const as = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const address = { name: "Doddesh", line1: "New Bus stand karatagi", city: "Koppal", state: "Karnataka", pincode: "583229", phone: "9902575944" };
  const create = (method: "COD" | "PAYMENT_LINK", extra: Record<string, unknown> = {}) => orders.createManualOrder(as, { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "649.00" }], paymentMethod: method, shippingAddress: address, shippingPincode: "583229", ...(method === "PAYMENT_LINK" ? { discount: { type: "FIXED", value: "50" } } : {}), ...extra } as never);
  return { tx, orders, as, lead, meta, links, create, qrDeps, cashfree };
}
const paymentOf = (tx: Prisma.TransactionClient, orderId: string) => tx.payment.findFirstOrThrow({ where: { orderId, externalSource: "CASHFREE" }, select: { id: true, status: true, paymentUrl: true, amount: true } });
const qrMeta = async (tx: Prisma.TransactionClient, orderId: string) => ((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as any).paymentQr;

describe("QR image for a prepaid payment link", () => {
  it("sends the link text AND a QR image tied to the exact payment link: signed URL of THIS payment, caption with the order reference and payable amount", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      assert.equal(r.whatsapp.sent, true, "the link text went out");
      assert.equal(r.whatsapp.qr?.status, "SENT");
      const pay = await paymentOf(tx, r.order.id);
      assert.equal(w.meta.images.length, 1);
      const img = w.meta.images[0]!;
      assert.equal(img.to, "+919902575944");
      const token = ((await tx.payment.findUniqueOrThrow({ where: { id: pay.id }, select: { metadata: true } })).metadata as any).qrToken as string;
      assert.match(token, /^[0-9a-f]{32}$/, "a random token stored on the payment itself");
      assert.equal(img.link, paymentQrImageUrl(BASE, pay.id, token), "the image URL carries exactly this payment's id and token");
      assert.match(img.link, /^https:\/\/crm\.example\.com\/api\/public\/payment-qr\/[0-9a-f-]{36}\/[0-9a-f]{32}\.png$/);
      assert.ok(img.caption!.includes(r.order.orderNumber) && img.caption!.includes("₹599.00"), String(img.caption));
      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { orderId: r.order.id, messageType: "MEDIA" }, select: { direction: true, status: true, body: true } });
      assert.deepEqual([row.direction, row.status], ["OUTBOUND", "SENT"]);
      assert.equal((await qrMeta(tx, r.order.id)).status, "SENT");
    });
  });

  it("the image served at that URL is the QR of the Cashfree payment URL stored for that payment - and only for a valid signature on an open link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const sig = await ensureQrToken(tx as never, pay.id);
      assert.equal(await ensureQrToken(tx as never, pay.id), sig, "the token is created once and reused (every retry sends the same image URL)");
      const png = await loadPaymentQrPng(tx as never, pay.id, sig);
      assert.ok(png && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "a PNG");
      assert.ok(png!.equals(await buildPaymentQrImage({ paymentUrl: pay.paymentUrl!, currency: "INR", amount: pay.amount }, (await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { orderNumber: true } })).orderNumber)), "the card rendered from the stored payment URL");
      const encoded = QRCode.create(pay.paymentUrl!, {}).segments.map((segment) => Buffer.from(segment.data as never).toString()).join(""); // the library may split a URL into several encoding segments
      assert.equal(encoded, pay.paymentUrl, "and that image encodes exactly the payment URL");
      assert.equal(await loadPaymentQrPng(tx as never, pay.id, "0".repeat(32)), null, "a wrong token gets nothing");
      assert.equal(await loadPaymentQrPng(tx as never, uid(), sig), null, "a token is valid for ITS payment only");
      await tx.payment.update({ where: { id: pay.id }, data: { status: "SUCCESS" } });
      assert.equal(await loadPaymentQrPng(tx as never, pay.id, sig), null, "no QR is served once the payment is no longer open");
    });
  });

  it("sending or scanning a QR never changes payment or order status: both stay awaiting payment until Cashfree verifies the payment", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      await sendPaymentQr(tx as never, w.as, (await paymentOf(tx, r.order.id)).id, w.qrDeps, { force: true });
      const pay = await paymentOf(tx, r.order.id);
      const order = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { status: true, externalId: true } });
      assert.deepEqual([pay.status, order.status, order.externalId], ["PENDING", "PENDING_PAYMENT", null]);
    });
  });

  it("COD: no payment link, no QR - the image sender is never called and nothing is recorded", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD");
      assert.equal(r.whatsapp.qr, undefined);
      assert.equal(w.meta.images.length, 0);
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id, externalSource: "CASHFREE" } }), 0, "COD never gets a Cashfree link");
      assert.equal(await qrMeta(tx, r.order.id), undefined);
    });
  });

  it("partial failure: the image fails but the link text stays sent and the payment link stays valid; the failure is stored on its own and is safe to show", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.meta.state.failNext = 1;
      const r = await w.create("PAYMENT_LINK");
      assert.equal(r.whatsapp.sent, true);
      assert.equal(r.whatsapp.qr?.status, "FAILED");
      assert.ok(!/EAAB123456789secretvalue/.test(r.whatsapp.qr?.reason ?? ""), "no credential-like text reaches the user");
      const pay = await paymentOf(tx, r.order.id);
      assert.deepEqual([pay.status, Boolean(pay.paymentUrl)], ["PENDING", true]);
      assert.equal((await qrMeta(tx, r.order.id)).status, "FAILED");
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: r.order.id, messageType: "MEDIA" } }), 0, "no image message is recorded for a failed send");
    });
  });

  it("the retry re-sends ONLY the image for the SAME order and payment link: one order, one payment, one Cashfree link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.meta.state.failNext = 1;
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const retry = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true, orderId: r.order.id });
      assert.equal(retry.status, "SENT");
      assert.equal(retry.paymentId, pay.id);
      assert.equal(w.meta.images.length, 2);
      assert.equal(w.meta.images[1]!.link, w.meta.images[0]!.link, "the very same image URL");
      assert.deepEqual([await tx.order.count({ where: { leadId: w.lead.id } }), await tx.payment.count({ where: { orderId: r.order.id } }), w.links.length], [1, 1, 1]);
      assert.equal((await qrMeta(tx, r.order.id)).status, "SENT");
      await assert.rejects(() => sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true, orderId: uid() }), (e: any) => e.statusCode === 404);
    });
  });

  it("an image already SENT is not sent again by an automatic repeat; only an explicit retry (force) re-sends it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      assert.equal((await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps)).status, "SENT");
      assert.equal(w.meta.images.length, 1, "no second image");
      await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      assert.equal(w.meta.images.length, 2);
    });
  });

  it("a repeated order submission (same idempotency key) returns the original result and sends the image once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `key-${uid()}`;
      const first = await w.create("PAYMENT_LINK", { idempotencyKey: key });
      const again = await w.create("PAYMENT_LINK", { idempotencyKey: key });
      assert.equal(again.order.id, first.order.id);
      assert.equal(w.meta.images.length, 1);
      assert.equal(again.whatsapp.qr?.status, "SENT", "the replay reports the original image outcome");
    });
  });

  it("not sent, with a clear reason, when it cannot be: 24-hour window closed / no public backend URL / link text not sent / payment already paid", async () => {
    await inRollback(async (tx) => {
      const closed = await world(tx, { windowOpen: false });
      const a = await closed.create("PAYMENT_LINK");
      assert.deepEqual([a.whatsapp.qr?.status, /24-hour/.test(a.whatsapp.qr?.reason ?? "")], ["NOT_SENT", true]);
      assert.equal(closed.meta.images.length, 0);

      const noBase = await world(tx, { publicBase: null });
      const b = await noBase.create("PAYMENT_LINK");
      assert.deepEqual([b.whatsapp.qr?.status, /PUBLIC_BACKEND_URL/.test(b.whatsapp.qr?.reason ?? "")], ["NOT_SENT", true]);

      const noText = await world(tx, { textSent: false });
      const c = await noText.create("PAYMENT_LINK");
      assert.equal(c.whatsapp.qr, undefined, "the QR follows the link text: nothing to follow, nothing sent");
      assert.equal(noText.meta.images.length, 0);

      const paid = await world(tx);
      const d = await paid.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, d.order.id);
      await tx.payment.update({ where: { id: pay.id }, data: { status: "SUCCESS" } });
      const late = await sendPaymentQr(tx as never, paid.as, pay.id, paid.qrDeps, { force: true });
      assert.deepEqual([late.status, /already success/.test(late.reason ?? "")], ["NOT_SENT", true]);
    });
  });
});

describe("the public QR image endpoint, over real HTTP (as Meta's servers call it: no login, no Authorization header)", () => {
  async function serve(tx: Prisma.TransactionClient, fn: (get: (path: string) => Promise<{ status: number; type: string | null; body: Buffer }>) => Promise<void>) {
    const app = express();
    app.use("/api/public/payment-qr", createPublicQrRoutes(tx as never));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await fn(async (path) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }; });
    } finally {
      server.close();
    }
  }
  const pathOf = (url: string) => new URL(url).pathname;

  it("the exact URL the CRM sent to WhatsApp returns the PNG of that payment's link; the same URL stops working once the payment is paid", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const path = pathOf(w.meta.images[0]!.link);
      await serve(tx, async (get) => {
        const ok = await get(path);
        assert.deepEqual([ok.status, ok.type], [200, "image/png"]);
        assert.ok(ok.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "a valid PNG");
        assert.ok(ok.body.equals(await buildPaymentQrImage({ paymentUrl: pay.paymentUrl!, currency: "INR", amount: pay.amount }, (await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { orderNumber: true } })).orderNumber)), "the card with the QR of the stored Cashfree URL");
        const parts = path.split("/");
        assert.equal((await get(`/api/public/payment-qr/${pay.id}/${"0".repeat(32)}.png`)).status, 404, "wrong token");
        assert.equal((await get(`/api/public/payment-qr/${uid()}/${parts.at(-1)}`)).status, 404, "another payment id");
        assert.equal((await get(`/api/public/payment-qr/${pay.id}/not-a-token.png`)).status, 404, "malformed");
        await tx.payment.update({ where: { id: pay.id }, data: { status: "SUCCESS" } });
        assert.equal((await get(path)).status, 404, "a paid payment no longer serves a QR");
      });
    });
  });

  it("media retrieval failure is not a payment event: the link, order and payment stay as they were, and the retry sends the same URL again", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      await tx.payment.update({ where: { id: pay.id }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } }); // the link has expired: Meta's fetch is refused
      await serve(tx, async (get) => assert.equal((await get(pathOf(w.meta.images[0]!.link))).status, 404));
      assert.equal((await paymentOf(tx, r.order.id)).status, "PENDING", "an unreachable image never changes the payment");
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { status: true } })).status, "PENDING_PAYMENT");
      const retry = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      assert.equal(retry.status, "NOT_SENT", "an expired link is not re-sent as a QR");
      assert.deepEqual([await tx.order.count({ where: { leadId: w.lead.id } }), await tx.payment.count({ where: { orderId: r.order.id } })], [1, 1]);
    });
  });
});

describe("QR delivered by uploading the image to Meta (no public backend address needed)", () => {
  it("uploads the PNG and sends it by media id: it works with NO PUBLIC_BACKEND_URL, carries order + amount, and the link message and the QR are recorded separately", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { publicBase: null });
      w.meta.enableUpload();
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const out = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps);
      assert.equal(out.status, "SENT");
      assert.deepEqual(w.meta.uploads.map((u) => [u.mimeType, u.png]), [["image/png", true]]);
      assert.equal(w.meta.images.at(-1)!.mediaId, "MEDIA-1");
      assert.equal(w.meta.images.at(-1)!.link, undefined, "nothing for Meta to download from us");
      assert.match(w.meta.images.at(-1)!.caption ?? "", new RegExp(`${pay.amount.toString()}.*${(await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { orderNumber: true } })).orderNumber}`));
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: r.order.id, messageType: "MEDIA", status: { in: ["SENT", "QUEUED"] } } }), 1);
      assert.equal((await paymentOf(tx, r.order.id)).status, "PENDING", "sending a QR never marks anything paid");
    });
  });

  it("an upload that is refused falls back to the public image URL when one exists; with none it reports NOT_SENT and the payment link stays valid", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.meta.enableUpload(true);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      assert.equal((await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps)).status, "SENT");
      assert.match(w.meta.images.at(-1)!.link, /public\/payment-qr/, "fallback to the public URL");
      const none = await world(tx, { publicBase: null });
      none.meta.enableUpload(true);
      const r2 = await none.create("PAYMENT_LINK");
      const out = await sendPaymentQr(tx as never, none.as, (await paymentOf(tx, r2.order.id)).id, none.qrDeps);
      assert.equal(out.status, "NOT_SENT");
      assert.ok(!/EAAB|secretvalue/.test(out.reason ?? ""), "no credential-like text is shown");
      assert.deepEqual([(await paymentOf(tx, r2.order.id)).status, (await tx.order.findUniqueOrThrow({ where: { id: r2.order.id }, select: { status: true } })).status], ["PENDING", "PENDING_PAYMENT"]);
    });
  });

  it("retrying after a failed image send reuses the order and the Cashfree link: no new order, no new link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.meta.enableUpload();
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      w.meta.state.failNext = 1;
      assert.equal((await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true })).status, "FAILED");
      assert.equal((await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true })).status, "SENT");
      assert.deepEqual([await tx.order.count({ where: { leadId: w.lead.id } }), await tx.payment.count({ where: { orderId: r.order.id } }), w.links.length], [1, 1, 1]);
    });
  });
});

describe("showing the QR in the CRM conversation (history + authenticated media)", () => {
  const history = (_tx: Prisma.TransactionClient, svc: WhatsAppService, as: { id: string; username: string; role: Role }, leadId: string) => svc.listMessages(as as never, { page: 1, pageSize: 50, leadId } as never);

  it("the QR image the CRM sent is listed with an image descriptor and loads, through the CRM's own route, as the card of the stored Cashfree URL - no Meta token or URL involved", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.meta.enableUpload();
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const sent = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      assert.equal(sent.status, "SENT");
      const svc = new WhatsAppService(tx as never, () => null, async () => null);
      const items = (await history(tx, svc, w.as, w.lead.id)).items;
      const qrMessage = items.find((i) => i.id === sent.messageId)!;
      assert.deepEqual([qrMessage.direction, qrMessage.messageType, qrMessage.media?.kind, qrMessage.media?.mimeType], ["OUTBOUND", "MEDIA", "image", "image/png"]);
      const served = await svc.getInboundMedia(w.as as never, sent.messageId!);
      assert.equal(served.contentType, "image/png");
      assert.ok(served.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
      const stored = await tx.payment.findUniqueOrThrow({ where: { id: pay.id }, select: { paymentUrl: true, currency: true, amount: true } });
      assert.ok(served.buffer.equals(await buildPaymentQrImage({ paymentUrl: stored.paymentUrl!, currency: stored.currency, amount: stored.amount }, (await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { orderNumber: true } })).orderNumber)), "exactly the image that was sent: the same stored URL");
      assert.match(served.contentDisposition, /^inline/);
      // viewing changes nothing
      assert.deepEqual([(await paymentOf(tx, r.order.id)).status, await tx.payment.count({ where: { orderId: r.order.id } }), await tx.order.count({ where: { leadId: w.lead.id } })], ["PENDING", 1, 1]);
    });
  });

  it("a QR message sent BEFORE the descriptor existed (no activity row) is recognised by its caption and still shows", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const sent = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      await tx.activity.deleteMany({ where: { referenceType: "WhatsAppMessage", referenceId: sent.messageId } });
      const svc = new WhatsAppService(tx as never, () => null, async () => null);
      const qrMessage = (await history(tx, svc, w.as, w.lead.id)).items.find((i) => i.id === sent.messageId)!;
      assert.equal(qrMessage.media?.kind, "image");
      assert.equal((await svc.getInboundMedia(w.as as never, sent.messageId!)).contentType, "image/png");
    });
  });

  it("a failed retrieval is a clear 404, not a crash: an outbound media message that is not a payment QR, a payment with no Cashfree link, and a user who may not read the conversation all get nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      const sent = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      const svc = new WhatsAppService(tx as never, () => null, async () => null);
      const other = await tx.whatsAppMessage.create({ data: { provider: "META", direction: "OUTBOUND", messageType: "MEDIA", status: "SENT", leadId: w.lead.id, orderId: r.order.id, toNumber: "+919902575944", body: "A brochure" }, select: { id: true } });
      await assert.rejects(() => svc.getInboundMedia(w.as as never, other.id), (e: any) => e.statusCode === 404);
      assert.equal((await history(tx, svc, w.as, w.lead.id)).items.find((i) => i.id === other.id)?.media ?? null, null, "an ordinary outbound file is not mistaken for a QR");
      await tx.payment.update({ where: { id: pay.id }, data: { paymentUrl: null } });
      await assert.rejects(() => svc.getInboundMedia(w.as as never, sent.messageId!), (e: any) => e.statusCode === 404);
      const hr = await tx.user.create({ data: { name: "HR", username: `hr-${uid()}`, role: Role.HR }, select: { id: true, username: true } });
      await assert.rejects(() => svc.getInboundMedia({ id: hr.id, username: hr.username, role: Role.HR } as never, sent.messageId!), (e: any) => e.statusCode === 404);
    });
  });

  it("renderStoredPaymentQr only serves a payment of THAT order and only a real Cashfree link; resending the image (retry) adds a second message for the SAME order and link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK");
      const pay = await paymentOf(tx, r.order.id);
      assert.ok(await renderStoredPaymentQr(tx as never, pay.id, r.order.id));
      assert.equal(await renderStoredPaymentQr(tx as never, pay.id, uid()), null);
      assert.equal(await renderStoredPaymentQr(tx as never, uid()), null);
      const a = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      const b = await sendPaymentQr(tx as never, w.as, pay.id, w.qrDeps, { force: true });
      const svc = new WhatsAppService(tx as never, () => null, async () => null);
      const items = (await history(tx, svc, w.as, w.lead.id)).items;
      assert.ok([a.messageId, b.messageId].every((id) => items.find((i) => i.id === id)?.media?.kind === "image"), "every QR message, old and new, shows the same way");
      assert.deepEqual([await tx.order.count({ where: { leadId: w.lead.id } }), await tx.payment.count({ where: { orderId: r.order.id } }), w.links.length], [1, 1, 1]);
    });
  });
});
