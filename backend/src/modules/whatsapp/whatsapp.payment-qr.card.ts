import { createRequire } from "node:module";
import QRCode from "qrcode";
import { logger } from "@/utils/logger.js";

// The branded payment card that is sent on WhatsApp and shown in the CRM: merchant name, order reference, exact amount, a large QR code and short instructions.
//
//  - The QR is drawn module by module from QRCode.create(paymentUrl) - the very URL stored on the Cashfree payment - as plain black squares on white with a full quiet zone (4 modules, the QR standard). Nothing
//    (logo, text, colour, overlay) is ever drawn inside the QR or its quiet zone, so it scans like the plain QR.
//  - Nothing here creates a link, changes an amount or touches a payment: it only turns existing data into a picture. It never says the payment is verified or guaranteed - it asks the customer to check the
//    merchant name in their payment app.
//  - The drawing library and font are loaded lazily; if either is unavailable (a missing native binary, a font that cannot be read) the caller gets an error and falls back to the plain QR image.

export interface PaymentCardInput {
  /** The exact stored Cashfree payment link URL the QR encodes. */
  paymentUrl: string;
  orderNumber: string;
  currency: string;
  amount: string;
  merchantName: string;
}

export const CARD_WIDTH = 1080;
const MARGIN = 72;
const QUIET_MODULES = 4;
const QR_BOX = 900; // the QR symbol plus its quiet zone are drawn inside a square of about this size
const BRAND = "#1f6b4f";
const INK = "#1b1f23";
const MUTED = "#5b6470";

export interface CardLayout {
  height: number;
  /** Top-left of the first QR module and the size of one module in pixels (an integer, so every module is pixel-exact). */
  qr: { x: number; y: number; moduleSize: number; modules: number; quiet: number };
}

/** Pure geometry (also used by the tests to locate the modules in the PNG). */
export function layoutPaymentCard(paymentUrl: string): CardLayout {
  const modules = QRCode.create(paymentUrl, { errorCorrectionLevel: "M" }).modules.size;
  const moduleSize = Math.max(Math.floor(QR_BOX / (modules + 2 * QUIET_MODULES)), 4);
  const full = moduleSize * (modules + 2 * QUIET_MODULES);
  const boxX = Math.round((CARD_WIDTH - full) / 2);
  const boxY = 490;
  return { height: boxY + full + 420, qr: { x: boxX + QUIET_MODULES * moduleSize, y: boxY + QUIET_MODULES * moduleSize, moduleSize, modules, quiet: QUIET_MODULES } };
}

const currencySymbol = (currency: string): string => (currency === "INR" ? "₹" : `${currency} `);
export const formatCardAmount = (currency: string, amount: string): string => `${currencySymbol(currency)}${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let fontsReady: Promise<void> | null = null;

async function loadCanvas() {
  const canvas = await import("@napi-rs/canvas");
  fontsReady ??= (async () => {
    const require = createRequire(import.meta.url);
    const dir = require.resolve("dejavu-fonts-ttf/package.json").replace(/package\.json$/, "");
    const ok = [canvas.GlobalFonts.registerFromPath(`${dir}ttf/DejaVuSans.ttf`, "CardSans"), canvas.GlobalFonts.registerFromPath(`${dir}ttf/DejaVuSans-Bold.ttf`, "CardSansBold")];
    if (ok.some((r) => !r)) throw new Error("Card fonts could not be loaded");
  })().catch((error) => {
    fontsReady = null; // try again next time rather than caching a failure
    throw error;
  });
  await fontsReady;
  return canvas;
}

/** Wraps `text` into lines that fit `maxWidth` for the font already set on the context. */
function wrap(ctx: { measureText: (t: string) => { width: number } }, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderPaymentCardPng(input: PaymentCardInput): Promise<Buffer> {
  const { createCanvas } = await loadCanvas();
  const layout = layoutPaymentCard(input.paymentUrl);
  const height = layout.height;
  const canvas = createCanvas(CARD_WIDTH, height);
  const ctx = canvas.getContext("2d");
  const centre = CARD_WIDTH / 2;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CARD_WIDTH, height);

  // Brand header
  ctx.fillStyle = BRAND;
  ctx.fillRect(0, 0, CARD_WIDTH, 16);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = BRAND;
  ctx.font = "56px CardSansBold";
  ctx.fillText(input.merchantName, centre, 130);
  ctx.fillStyle = MUTED;
  ctx.font = "32px CardSans";
  ctx.fillText("Payment request", centre, 184);
  ctx.fillStyle = "#e3e8e6";
  ctx.fillRect(MARGIN, 220, CARD_WIDTH - 2 * MARGIN, 3);

  // Amount + order
  ctx.fillStyle = MUTED;
  ctx.font = "30px CardSans";
  ctx.fillText("Amount to pay", centre, 290);
  ctx.fillStyle = INK;
  ctx.font = "88px CardSansBold";
  ctx.fillText(formatCardAmount(input.currency, input.amount), centre, 384);
  ctx.fillStyle = MUTED;
  ctx.font = "30px CardSans";
  ctx.fillText(`Order ${input.orderNumber}`, centre, 436);

  // QR: white box (the quiet zone is part of it), then the modules as exact black squares.
  const { x, y, moduleSize, modules, quiet } = layout.qr;
  const full = moduleSize * (modules + 2 * quiet);
  const boxX = x - quiet * moduleSize;
  const boxY = y - quiet * moduleSize;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(boxX, boxY, full, full);
  const matrix = QRCode.create(input.paymentUrl, { errorCorrectionLevel: "M" }).modules;
  ctx.fillStyle = "#000000";
  for (let r = 0; r < modules; r++) for (let c = 0; c < modules; c++) if (matrix.get(r, c)) ctx.fillRect(x + c * moduleSize, y + r * moduleSize, moduleSize, moduleSize);
  ctx.strokeStyle = "#d5dbd9";
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX - 14, boxY - 14, full + 28, full + 28); // frame OUTSIDE the quiet zone

  // Instructions
  let ty = boxY + full + 76;
  ctx.fillStyle = INK;
  ctx.font = "34px CardSansBold";
  ctx.fillText("How to pay", centre, ty);
  ctx.textAlign = "left";
  ctx.font = "30px CardSans";
  ctx.fillStyle = INK;
  for (const step of ["1.  Open any UPI app and scan this QR code.", "2.  Check the merchant name shown in your app.", "3.  Confirm the amount and complete the payment."]) {
    ty += 50;
    ctx.fillText(step, MARGIN + 60, ty);
  }
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = "26px CardSans";
  ty += 62;
  for (const line of wrap(ctx, "Please verify the merchant name in your payment app before paying. You can also use the payment link sent in this chat.", CARD_WIDTH - 2 * MARGIN - 40)) {
    ctx.fillText(line, centre, ty);
    ty += 36;
  }
  return canvas.toBuffer("image/png");
}

/** The card, or null (logged, never thrown) when it cannot be drawn - the caller then sends the plain QR. */
export async function tryRenderPaymentCardPng(input: PaymentCardInput): Promise<Buffer | null> {
  try {
    return await renderPaymentCardPng(input);
  } catch (error) {
    logger.warn(`Payment QR card could not be drawn, the plain QR is used instead: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
    return null;
  }
}
