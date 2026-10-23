import { createRequire } from "node:module";
import { PNG } from "pngjs";
import { toCents } from "../shopify/shopify.money.js";

// jsQR is a CommonJS package: loaded with require so it behaves the same under tsx and the compiled build.
const jsQR = createRequire(import.meta.url)("jsqr") as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

// WHAT A QR REALLY ENCODES. A PNG that Cashfree returned is only called a "direct UPI QR" after it is DECODED and its content is a UPI payment request (upi://pay?...) with the exact amount and currency of the CRM payment.
// A QR that encodes a web address (a Cashfree checkout page, the payment link), an unreadable picture, or a UPI request for another amount / currency is refused - it would open a browser, or ask the customer for the wrong amount.
// Nothing is generated or guessed here: the QR bytes are the provider's; this only reads them. The reason strings never contain the encoded content (it carries the merchant's UPI id).

export type QrContentKind = "upi_pay" | "web_link" | "other" | "unreadable";

export interface QrInspection {
  kind: QrContentKind;
  /** upi_pay only: the amount (am) and currency (cu) of the request, as written in it. */
  amount: string | null;
  currency: string | null;
  hasPayee: boolean;
  /** upi_pay only: the payee (pa). Used for the comparison with the configured merchant UPI id; never put in an error message. */
  payee: string | null;
}

const MAX_SIDE = 2000;

/** The text a QR PNG encodes, or null when the picture cannot be read as a QR code. */
export function decodeQrPng(png: Buffer): string | null {
  try {
    const image = PNG.sync.read(png);
    if (image.width < 40 || image.height < 40 || image.width > MAX_SIDE || image.height > MAX_SIDE) return null;
    return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data ?? null;
  } catch {
    return null;
  }
}

export function inspectQrText(text: string | null): QrInspection {
  const none = { amount: null, currency: null, hasPayee: false, payee: null };
  if (!text) return { kind: "unreadable", ...none };
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { kind: "other", ...none };
  }
  if (url.protocol === "http:" || url.protocol === "https:") return { kind: "web_link", ...none };
  // UPI deep link (NPCI): upi://pay?pa=<payee>&am=<amount>&cu=<currency>...
  if (url.protocol === "upi:" && url.hostname.toLowerCase() === "pay") {
    const payee = (url.searchParams.get("pa") ?? "").trim();
    return { kind: "upi_pay", amount: url.searchParams.get("am"), currency: url.searchParams.get("cu"), hasPayee: Boolean(payee), payee: payee || null };
  }
  return { kind: "other", ...none };
}

/**
 * Throws (a safe message, never the QR content) unless the PNG is a direct UPI payment request for exactly `expected`: a UPI pay link with a payee, the same amount to the paisa, and the same currency.
 * Returns what was found, for the audit trail.
 */
export function assertDirectUpiQr(png: Buffer, expected: { amount: string; currency: string; /** The merchant's UPI id (CASHFREE_UPI_QR_EXPECTED_PAYEE) when it is known: the QR must pay exactly that payee. */ payee?: string }): QrInspection {
  const found = inspectQrText(decodeQrPng(png));
  if (found.kind === "web_link") throw new Error("Cashfree's QR opens a web page (a checkout or payment link), not a UPI payment screen, so it was not used.");
  if (found.kind === "unreadable") throw new Error("Cashfree's QR image could not be read as a QR code, so it was not used.");
  if (found.kind === "other") throw new Error("Cashfree's QR is not a UPI payment request (upi://pay), so it was not used.");
  if (!found.hasPayee) throw new Error("Cashfree's UPI QR has no payee, so it was not used.");
  if (expected.payee && found.payee?.trim().toLowerCase() !== expected.payee.trim().toLowerCase()) throw new Error("Cashfree's UPI QR pays a different payee than the configured merchant UPI id, so it was not used.");
  if (!found.amount || toCents(found.amount) !== toCents(expected.amount)) throw new Error("Cashfree's UPI QR does not carry the payment's exact amount, so it was not used.");
  if ((found.currency ?? "").toUpperCase() !== expected.currency.toUpperCase()) throw new Error("Cashfree's UPI QR does not carry the payment's currency, so it was not used.");
  return found;
}
