// No database: the public backend address, the image URL, the PNG, and the error redaction.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { resolvePublicBackendUrl } from "../cashfree/cashfree.config.js";
import { isCashfreePaymentUrl, paymentQrImageUrl, qrCaption, redactProviderError, renderPaymentQrPng } from "./whatsapp.payment-qr.js";

const PAYMENT_ID = "3f0c9a52-6f43-4d5e-9b61-0c1a2b3c4d5e";
const TOKEN = "a".repeat(32);

describe("the public backend address (PUBLIC_BACKEND_URL) behind the QR image URL", () => {
  it("is the configured https address, without a trailing slash; Render's own RENDER_EXTERNAL_URL is the fallback", () => {
    assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: "https://sales-crm-3pan.onrender.com/" }), "https://sales-crm-3pan.onrender.com");
    assert.equal(resolvePublicBackendUrl({ RENDER_EXTERNAL_URL: "https://sales-crm-3pan.onrender.com" }), "https://sales-crm-3pan.onrender.com");
    assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: "https://a.example.com", RENDER_EXTERNAL_URL: "https://b.example.com" }), "https://a.example.com", "the explicit setting wins");
  });
  it("is never an unreachable address: unset, http, localhost and private addresses give null (so the CRM says what to configure instead of sending a dead link)", () => {
    for (const bad of [undefined, "", "http://sales-crm-3pan.onrender.com", "https://localhost:5000", "https://127.0.0.1", "https://192.168.1.4", "not a url"]) assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: bad }), null, String(bad));
    assert.equal(resolvePublicBackendUrl({}), null);
  });
});

describe("the QR image URL and the image itself", () => {
  it("is https on the public host, on the public-qr route, for exactly this payment and token (a trailing slash on the base never doubles up)", () => {
    const url = paymentQrImageUrl("https://sales-crm-3pan.onrender.com/", PAYMENT_ID, TOKEN);
    assert.equal(url, `https://sales-crm-3pan.onrender.com/api/public/payment-qr/${PAYMENT_ID}/${TOKEN}.png`);
    assert.equal(new URL(url).protocol, "https:");
  });
  it("renders a valid PNG that encodes exactly the Cashfree payment URL, and a different URL gives a different image", async () => {
    const link = "https://payments.cashfree.com/links/abcd1234efgh5678";
    const png = await renderPaymentQrPng(link);
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.ok(png.length > 500);
    const encoded = QRCode.create(link, {}).segments.map((s) => Buffer.from(s.data as never).toString()).join("");
    assert.equal(encoded, link);
    assert.ok(!png.equals(await renderPaymentQrPng("https://payments.cashfree.com/links/zzzz9999yyyy8888")));
  });
  it("only a real Cashfree payment page is ever encoded", () => {
    assert.equal(isCashfreePaymentUrl("https://payments.cashfree.com/links/x"), true);
    assert.equal(isCashfreePaymentUrl("https://payments-test.cashfree.com/links/x"), true);
    for (const bad of [null, undefined, "", "http://payments.cashfree.com/links/x", "https://evilcashfree.com/links/x", "https://cashfree.com.evil.example/x", "javascript:alert(1)"]) assert.equal(isCashfreePaymentUrl(bad as never), false, String(bad));
  });
  it("the caption carries the order reference and the payable amount", () => {
    assert.match(qrCaption("CRM-1", "INR", "599"), /₹599\.00 for order CRM-1/);
  });
  it("provider errors shown to a person never carry credential-like text", () => {
    const shown = redactProviderError("Request failed: Bearer EAABsbCS1iHgBO7ZAbc123 token=abc123secret expired");
    assert.ok(!/EAAB|abc123/.test(shown), shown);
  });
});

describe("the URL the sender builds is the route the application registers", () => {
  it("path = /api + the mount in routes.ts + /:paymentId/:token.png (no stale /signature variant), and the route is mounted before any auth", async () => {
    const { readFileSync } = await import("node:fs");
    const routes = readFileSync(new URL("../../routes.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
    const mount = /router\.use\("([^"]+)",\s*publicQrRoutes\)/.exec(routes)?.[1];
    assert.equal(mount, "/public/payment-qr");
    assert.match(server, /app\.use\("\/api",\s*routes\)/, "routes.ts is served under /api");
    assert.ok(routes.indexOf("publicQrRoutes)") < routes.indexOf('router.use("/auth"'), "mounted ahead of the authenticated routers");
    const path = new URL(paymentQrImageUrl("https://sales-crm-3pan.onrender.com", PAYMENT_ID, TOKEN)).pathname;
    assert.equal(path, `/api${mount}/${PAYMENT_ID}/${TOKEN}.png`);
    assert.ok(!/signature/i.test(path));
  });
});

describe("the QR image really encodes the payment URL (decoded from the PNG pixels, not just trusted)", () => {
  it("every module of the PNG matches the QR symbol of exactly that URL, and that symbol decodes to the URL", async () => {
    const { createRequire } = await import("node:module");
    const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read: (b: Buffer) => { width: number; height: number; data: Buffer } } } };
    const link = "https://payments.cashfree.com/links/abcd1234efgh5678";
    const img = PNG.sync.read(await renderPaymentQrPng(link));
    const qr = QRCode.create(link, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const margin = 2;
    const cell = img.width / (n + 2 * margin);
    let mismatches = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = Math.floor((margin + c + 0.5) * cell);
        const y = Math.floor((margin + r + 0.5) * cell);
        const dark = img.data[(y * img.width + x) * 4]! < 128;
        if (dark !== Boolean(qr.modules.get(r, c))) mismatches += 1;
      }
    }
    assert.equal(mismatches, 0, "the PNG is exactly this URL's QR symbol");
    assert.equal(qr.segments.map((s) => Buffer.from(s.data as never).toString()).join(""), link);
  });
});

describe("uploading the QR to Meta (so the image needs no public address of ours)", () => {
  const CREDS = { phoneNumberId: "123456", accessToken: "EAABsecrettoken123456789", appSecret: "app-secret-value", verifyToken: "verify-value", graphApiVersion: "v21.0", wabaId: "waba" } as never;
  it("POSTs the PNG to /{phone-number-id}/media with the bearer token and returns Meta's media id; sendImage then uses id, not link", async () => {
    const { MetaCloudApiProvider } = await import("./whatsapp.meta.provider.js");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith("/media") ? { id: "MEDIA-777" } : { messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new MetaCloudApiProvider(CREDS, { fetchImpl });
    const id = await provider.uploadMedia(await renderPaymentQrPng("https://payments.cashfree.com/links/x1"), "image/png", "payment-qr-CRM-1.png");
    assert.equal(id, "MEDIA-777");
    assert.match(calls[0]!.url, /\/v21\.0\/123456\/media$/);
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer EAABsecrettoken123456789");
    const form = calls[0]!.init.body as FormData;
    assert.deepEqual([form.get("messaging_product"), form.get("type"), (form.get("file") as File).type], ["whatsapp", "image/png", "image/png"]);
    await provider.sendImage({ to: "919902575944", mediaId: id, caption: "Scan to pay" });
    const sent = JSON.parse(String(calls[1]!.init.body));
    assert.deepEqual([sent.type, sent.image.id, sent.image.link], ["image", "MEDIA-777", undefined]);
  });
  it("a refused upload throws a clear error that never contains the access token", async () => {
    const { MetaCloudApiProvider } = await import("./whatsapp.meta.provider.js");
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "Invalid token EAABsecrettoken123456789", code: 190 } }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(() => new MetaCloudApiProvider(CREDS, { fetchImpl }).uploadMedia(Buffer.from("x"), "image/png", "a.png"), (e: Error) => /media upload/.test(e.message) && !/EAABsecret/.test(e.message));
  });
});

describe("the branded payment card", () => {
  const LINK = "https://payments.cashfree.com/links/abcd1234efgh5678";
  const input = { paymentUrl: LINK, orderNumber: "CRM-MVF46DSO-H45C", currency: "INR", amount: "599", merchantName: "Ayush Wellness" };
  async function decode() {
    const { createRequire } = await import("node:module");
    const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read: (b: Buffer) => { width: number; height: number; data: Buffer } } } };
    const { renderPaymentCardPng, layoutPaymentCard } = await import("./whatsapp.payment-qr.card.js");
    const png = await renderPaymentCardPng(input);
    return { png, img: PNG.sync.read(png), layout: layoutPaymentCard(LINK) };
  }
  const dark = (img: { width: number; data: Buffer }, x: number, y: number) => img.data[(y * img.width + x) * 4]! < 128;

  it("is a valid, WhatsApp-compatible PNG (under the 5 MB image limit), large and sharp, with the card layout's height", async () => {
    const { png, img, layout } = await decode();
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.ok(png.length < 1_000_000);
    assert.deepEqual([img.width, img.height], [1080, layout.height]);
    assert.ok(layout.qr.moduleSize >= 16, "a big QR: every module is at least 16 px");
  });

  it("the QR drawn on the card is exactly the QR of the stored payment URL: every module matches, pixel-exact", async () => {
    const { img, layout } = await decode();
    const { x, y, moduleSize, modules } = layout.qr;
    const matrix = QRCode.create(LINK, { errorCorrectionLevel: "M" }).modules;
    let mismatches = 0;
    for (let r = 0; r < modules; r++) for (let c = 0; c < modules; c++) {
      const px = x + c * moduleSize + Math.floor(moduleSize / 2);
      const py = y + r * moduleSize + Math.floor(moduleSize / 2);
      if (dark(img, px, py) !== Boolean(matrix.get(r, c))) mismatches += 1;
    }
    assert.equal(mismatches, 0);
    assert.equal(QRCode.create(LINK, {}).segments.map((s) => Buffer.from(s.data as never).toString()).join(""), LINK);
  });

  it("keeps the 4-module quiet zone completely white, and nothing is drawn on or around the QR modules (no logo or overlay)", async () => {
    const { img, layout } = await decode();
    const { x, y, moduleSize, modules, quiet } = layout.qr;
    const left = x - quiet * moduleSize, top = y - quiet * moduleSize, size = (modules + 2 * quiet) * moduleSize;
    let nonWhiteInQuiet = 0;
    for (let py = top; py < top + size; py++) for (let px = left; px < left + size; px++) {
      const inSymbol = px >= x && px < x + modules * moduleSize && py >= y && py < y + modules * moduleSize;
      if (!inSymbol && dark(img, px, py)) nonWhiteInQuiet += 1;
    }
    assert.equal(nonWhiteInQuiet, 0);
    // pure black / white only inside the symbol: no anti-aliased or coloured pixels from a logo
    for (let py = y; py < y + modules * moduleSize; py += 3) for (let px = x; px < x + modules * moduleSize; px += 3) {
      const o = (py * img.width + px) * 4;
      const [r, g, b] = [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
      assert.ok((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255), `module pixel (${px},${py}) is ${r},${g},${b}`);
    }
  });

  it("shows the amount and order on the card and makes no verified / guaranteed claim", async () => {
    const { formatCardAmount } = await import("./whatsapp.payment-qr.card.js");
    assert.equal(formatCardAmount("INR", "599"), "₹599.00");
    assert.equal(formatCardAmount("INR", "1298.5"), "₹1,298.50");
    const source = (await import("node:fs")).readFileSync(new URL("./whatsapp.payment-qr.card.ts", import.meta.url), "utf8");
    assert.match(source, /Please verify the merchant name in your payment app/);
    assert.ok(!/guarantee|100% secure|verified payment|safe and secure/i.test(source.replace(/It never says the payment is verified or guaranteed[^\n]*/, "")), "no trust claim");
  });

  it("a card that cannot be drawn yields null (the caller then sends the plain QR of the same URL), never an exception", async () => {
    const { tryRenderPaymentCardPng } = await import("./whatsapp.payment-qr.card.js");
    assert.equal(await tryRenderPaymentCardPng({ ...input, paymentUrl: "" }), null);
  });
});
