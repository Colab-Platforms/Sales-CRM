// Validation of the agency's request. Every problem is reported (field + message), not just the first, so the agency can fix a request in one go.
import { createHash } from "node:crypto";
import { normalizeMobile } from "@/lib/leadIdentity.js";

export interface FieldError {
  field: string;
  message: string;
}

/** The ONLY two things the agency sends. The order, its amount and the payment link are all found / created by the CRM. */
export interface PaymentLinkRequest {
  customerName: string;
  /** Canonical "+<country><number>". */
  mobile: string;
}

const ACCEPTED_FIELDS = new Set(["customerName", "mobile"]);

const CONTROL = /[\u0000-\u001f\u007f]/;
export function validateMobile(raw: unknown): { mobile?: string; error?: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "mobile is required, with the country code, e.g. +919876543210" };
  const text = raw.trim();
  if (/[^\d+\s().-]/.test(text)) return { error: "mobile may contain only digits, spaces and + ( ) . -" };
  const digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00");
  if (!international) return { error: "mobile must include the country code and start with +, e.g. +919876543210" };
  const normalized = normalizeMobile(text);
  if (!normalized) return { error: "mobile is not a valid phone number (8 to 15 digits including the country code)" };
  const national = normalized.slice(1);
  if (national.startsWith("91") && !/^91[6-9]\d{9}$/.test(national)) return { error: "mobile is not a valid Indian mobile number (+91 followed by 10 digits starting 6-9)" };
  return { mobile: normalized };
}

export function validateRequest(body: unknown): { errors: FieldError[]; value?: PaymentLinkRequest } {
  const errors: FieldError[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "The request body must be a JSON object" }] };
  const b = body as Record<string, unknown>;

  // Anything else is refused, not ignored: an agency that still sends paymentLink / orderId must not believe it is being used.
  for (const name of Object.keys(b)) if (!ACCEPTED_FIELDS.has(name)) errors.push({ field: name, message: `${name} is not accepted. Send only customerName and mobile - the CRM finds the order, its amount and creates the payment link itself.` });

  let customerName = "";
  if (typeof b.customerName !== "string" || !b.customerName.trim()) errors.push({ field: "customerName", message: "customerName is required" });
  else if (b.customerName.trim().length > 100) errors.push({ field: "customerName", message: "customerName must be 100 characters or fewer" });
  else if (CONTROL.test(b.customerName)) errors.push({ field: "customerName", message: "customerName must not contain control characters" });
  else customerName = b.customerName.trim().replace(/\s+/g, " ");

  const mobile = validateMobile(b.mobile);
  if (mobile.error) errors.push({ field: "mobile", message: mobile.error });

  if (errors.length > 0) return { errors };
  return { errors, value: { customerName, mobile: mobile.mobile! } };
}

/** Stable fingerprint of what a request asks for (used to recognise a repeat, and to refuse an idempotency key reused for a different request). */
export function requestHash(v: PaymentLinkRequest): string {
  return createHash("sha256").update(JSON.stringify([v.mobile, v.customerName])).digest("hex");
}

export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  return digits.length <= 4 ? "*".repeat(digits.length) : `+${digits.slice(0, 2)}${"*".repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}
