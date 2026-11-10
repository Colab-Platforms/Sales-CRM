// Validation of the agency's request. Every problem is reported (field + message), not just the first, so the agency can fix a request in one go.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeMobile } from "@/lib/leadIdentity.js";

export interface FieldError {
  field: string;
  message: string;
}

export interface PaymentLinkRequest {
  customerName: string;
  /** Canonical "+<country><number>". */
  mobile: string;
  paymentLink: string;
  orderId: string | null;
  templateParams: Record<string, string>;
  customerConsent: true;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Set by the request itself; the agency cannot override them through templateParams. */
const RESERVED_PARAMS = new Set(["customer_name", "payment_link"]);
const MAX_PARAMS = 20;

export function defaultAllowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.AGENCY_PAYMENT_LINK_HOSTS ?? "cashfree.com,*.cashfree.com,cfre.in").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return raw.length > 0 ? raw : ["cashfree.com", "*.cashfree.com", "cfre.in"];
}

/** "*" allows any https host; "*.x.com" allows sub-domains of x.com; "x.com" allows exactly x.com. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => a === "*" || a === h || (a.startsWith("*.") && h.endsWith(a.slice(1)) && h.length > a.length - 1));
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  return isIP(h) !== 0; // a payment page is never a bare IP address
}

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

export function validatePaymentLink(raw: unknown, allowedHosts: string[]): { link?: string; host?: string; error?: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "paymentLink is required" };
  const text = raw.trim();
  if (text.length > 2000) return { error: "paymentLink is too long (2000 characters at most)" };
  if (CONTROL.test(text) || /\s/.test(text)) return { error: "paymentLink must not contain spaces or control characters" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "paymentLink is not a valid URL" };
  }
  if (url.protocol !== "https:") return { error: "paymentLink must be an https:// URL" };
  if (url.username || url.password) return { error: "paymentLink must not contain a username or password" };
  if (isPrivateHost(url.hostname)) return { error: "paymentLink must point to a public payment page, not a local or IP address" };
  if (!hostAllowed(url.hostname, allowedHosts)) return { error: `paymentLink host "${url.hostname}" is not an approved payment domain. Ask the CRM team to approve it.` };
  return { link: url.toString(), host: url.hostname.toLowerCase() };
}

export function validateRequest(body: unknown, allowedHosts: string[] = defaultAllowedHosts()): { errors: FieldError[]; value?: PaymentLinkRequest; linkHost?: string } {
  const errors: FieldError[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "The request body must be a JSON object" }] };
  const b = body as Record<string, unknown>;

  let customerName = "";
  if (typeof b.customerName !== "string" || !b.customerName.trim()) errors.push({ field: "customerName", message: "customerName is required" });
  else if (b.customerName.trim().length > 100) errors.push({ field: "customerName", message: "customerName must be 100 characters or fewer" });
  else if (CONTROL.test(b.customerName)) errors.push({ field: "customerName", message: "customerName must not contain control characters" });
  else customerName = b.customerName.trim().replace(/\s+/g, " ");

  const mobile = validateMobile(b.mobile);
  if (mobile.error) errors.push({ field: "mobile", message: mobile.error });

  const link = validatePaymentLink(b.paymentLink, allowedHosts);
  if (link.error) errors.push({ field: "paymentLink", message: link.error });

  let orderId: string | null = null;
  if (b.orderId !== undefined && b.orderId !== null && b.orderId !== "") {
    if (typeof b.orderId !== "string" || !/^[A-Za-z0-9._#-]{1,100}$/.test(b.orderId.trim())) errors.push({ field: "orderId", message: "orderId may contain letters, digits and . _ - # only (100 characters at most)" });
    else orderId = b.orderId.trim().replace(/^#/, "");
  }

  const templateParams: Record<string, string> = {};
  if (b.templateParams !== undefined && b.templateParams !== null) {
    if (typeof b.templateParams !== "object" || Array.isArray(b.templateParams)) errors.push({ field: "templateParams", message: "templateParams must be an object of name: text pairs" });
    else {
      const entries = Object.entries(b.templateParams as Record<string, unknown>);
      if (entries.length > MAX_PARAMS) errors.push({ field: "templateParams", message: `templateParams may have at most ${MAX_PARAMS} entries` });
      for (const [name, value] of entries) {
        if (!PARAM_NAME.test(name)) errors.push({ field: `templateParams.${name}`, message: "parameter names use lowercase letters, digits and underscores, starting with a letter" });
        else if (RESERVED_PARAMS.has(name)) errors.push({ field: `templateParams.${name}`, message: `${name} is set from the request itself and cannot be sent in templateParams` });
        else if (typeof value !== "string" && typeof value !== "number") errors.push({ field: `templateParams.${name}`, message: "parameter values must be text or numbers" });
        else {
          const text = String(value).trim();
          // WhatsApp refuses a template parameter with a new line, a tab or four spaces in a row.
          if (!text) errors.push({ field: `templateParams.${name}`, message: "parameter values must not be empty" });
          else if (text.length > 500) errors.push({ field: `templateParams.${name}`, message: "parameter values must be 500 characters or fewer" });
          else if (/[\n\r\t]| {4,}/.test(text)) errors.push({ field: `templateParams.${name}`, message: "parameter values must not contain new lines, tabs or four spaces in a row (WhatsApp rejects them)" });
          else templateParams[name] = text;
        }
      }
    }
  }

  if (b.customerConsent !== true) errors.push({ field: "customerConsent", message: "customerConsent must be true: the customer agreed, on the call, to receive this WhatsApp message" });

  if (errors.length > 0) return { errors };
  return { errors, value: { customerName, mobile: mobile.mobile!, paymentLink: link.link!, orderId, templateParams, customerConsent: true }, linkHost: link.host };
}

/** Stable fingerprint of what a request asks for (used to recognise a repeat, and to refuse an idempotency key reused for a different request). */
export function requestHash(v: PaymentLinkRequest): string {
  const params = Object.keys(v.templateParams).sort().map((k) => [k, v.templateParams[k]]);
  return createHash("sha256").update(JSON.stringify([v.mobile, v.paymentLink, v.orderId, v.customerName, params])).digest("hex");
}

export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  return digits.length <= 4 ? "*".repeat(digits.length) : `+${digits.slice(0, 2)}${"*".repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}
