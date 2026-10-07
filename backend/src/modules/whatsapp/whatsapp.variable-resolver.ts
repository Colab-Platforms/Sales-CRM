// E7.3: resolves a WhatsApp template's named {{placeholders}} from real CRM data (the customer's
// Lead and, when the template needs one, one specific Order they own). A registry of small pure
// functions, not an if/else chain, so adding a new resolvable variable later is one entry, not a
// restructure - exactly the extensibility the E7.3 spec asks for. A name outside the registry, or
// one the registry cannot resolve right now (e.g. an order-only variable with no order selected),
// both fail validation before anything is sent - never guessed, never silently blanked.
import { PaymentMethod, PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { computePaymentBreakdown, fullName } from "../orders/orders.filters.js";
import { deriveReconciliationStatus } from "../reconciliation/reconciliation.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { formatMoneyForMessage, summarizeItems } from "./whatsapp.order-message.js";

export interface ResolverLeadContext {
  firstName: string;
  lastName: string | null;
  mobile: string | null;
  normalizedMobile: string | null;
  email: string | null;
}

export interface ResolverShipmentContext {
  status: ShipmentStatus;
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  expectedDeliveryAt: Date | null;
}

export interface ResolverPaymentContext {
  status: PaymentStatus;
  method: PaymentMethod | null;
  amount: string;
  refundedAmount: string | null;
  // Set only on a payment the CRM created through a payment link; the link is what {{payment_link}} resolves to.
  paymentUrl?: string | null;
  paymentExpiresAt?: Date | null;
}

export interface ResolverOrderContext {
  orderNumber: string;
  externalNumber: string | null;
  status: string;
  currency: string;
  totalAmount: string;
  payments: ResolverPaymentContext[];
  latestShipment: ResolverShipmentContext | null;
  /** Product lines as the customer knows them (name, variant, quantity) - for {{product_summary}}. */
  items?: { productName: string; variantName: string | null; quantity: number }[];
}

export interface VariableResolutionContext {
  lead: ResolverLeadContext;
  order: ResolverOrderContext | null;
}

function humanize(value: string): string {
  return value.toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };
function formatCurrency(amount: string, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const formatDate = (d: Date) => DATE_FORMAT.format(d);

// The order's open payment link: a payment that has a link, is still awaiting payment, and has not expired. At most one
// exists per order (the CRM refuses to create a second), so "the" link is unambiguous.
function openPaymentLink(ctx: VariableResolutionContext): ResolverPaymentContext | null {
  const now = Date.now();
  return (
    ctx.order?.payments.find(
      (p) => !!p.paymentUrl && (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.PROCESSING) && (!p.paymentExpiresAt || p.paymentExpiresAt.getTime() > now),
    ) ?? null
  );
}

/** null = this variable is meaningful but not available in the given context (e.g. no order, no shipment yet). */
type Resolver = (ctx: VariableResolutionContext) => string | null;

const REGISTRY: Record<string, Resolver> = {
  customer_name: (ctx) => fullName(ctx.lead.firstName, ctx.lead.lastName),
  customer_first_name: (ctx) => ctx.lead.firstName,
  customer_mobile: (ctx) => ctx.lead.mobile ?? ctx.lead.normalizedMobile,
  customer_email: (ctx) => ctx.lead.email,

  order_number: (ctx) => ctx.order?.orderNumber ?? null,
  order_status: (ctx) => (ctx.order ? humanize(ctx.order.status) : null),
  order_amount: (ctx) => (ctx.order ? formatCurrency(ctx.order.totalAmount, ctx.order.currency) : null),
  outstanding_amount: (ctx) => {
    if (!ctx.order) return null;
    const breakdown = computePaymentBreakdown(ctx.order.payments);
    const outstandingCents = Math.max(toCents(ctx.order.totalAmount) - breakdown.paidCents, 0);
    return formatCurrency(fromCents(outstandingCents), ctx.order.currency);
  },
  payment_status: (ctx) => {
    if (!ctx.order) return null;
    const breakdown = computePaymentBreakdown(ctx.order.payments);
    const status = deriveReconciliationStatus(toCents(ctx.order.totalAmount), breakdown, ctx.order.payments.length > 0);
    return humanize(status);
  },

  // A resolved value is only ever the real link of a real, still-open payment - never a guess - so a template using
  // these fails validation (rather than sending a dead link) when the order has no open link.
  payment_link: (ctx) => openPaymentLink(ctx)?.paymentUrl ?? null,
  // "Skin, Hair & Nail Gummies (1 Jar) × 1, Brain Fuel Capsules × 2" - real product names and quantities, never ids.
  // The product name(s) on the order, in the order the lines were added ("Product A, Product B"); a repeated name is listed once. Never a
  // default: an order with no product name resolves to nothing, and the send is refused.
  product_name: (ctx) => {
    const names: string[] = [];
    for (const item of ctx.order?.items ?? []) {
      const name = item.productName.trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names.length > 0 ? names.join(", ") : null;
  },
  product_summary: (ctx) => (ctx.order?.items?.length ? summarizeItems(ctx.order.items.map((i) => ({ name: i.productName, variant: i.variantName, quantity: i.quantity }))) : null),
  // What the customer is asked to pay: the open payment link's amount when there is one, else the order total.
  amount: (ctx) => {
    if (!ctx.order) return null;
    const link = openPaymentLink(ctx);
    return formatMoneyForMessage(link ? fromCents(toCents(link.amount)) : ctx.order.totalAmount, ctx.order.currency);
  },
  payment_amount: (ctx) => {
    const link = openPaymentLink(ctx);
    return link && ctx.order ? formatCurrency(fromCents(toCents(link.amount)), ctx.order.currency) : null; // two decimals, exactly what the customer will be asked to pay
  },

  tracking_number: (ctx) => ctx.order?.latestShipment?.trackingNumber ?? null,
  tracking_url: (ctx) => ctx.order?.latestShipment?.trackingUrl ?? null,
  courier: (ctx) => ctx.order?.latestShipment?.courier ?? null,
  shipment_status: (ctx) => (ctx.order?.latestShipment ? humanize(ctx.order.latestShipment.status) : null),
  shipped_date: (ctx) => (ctx.order?.latestShipment?.shippedAt ? formatDate(ctx.order.latestShipment.shippedAt) : null),
  delivery_date: (ctx) => (ctx.order?.latestShipment?.deliveredAt ? formatDate(ctx.order.latestShipment.deliveredAt) : null),
  expected_delivery_date: (ctx) => (ctx.order?.latestShipment?.expectedDeliveryAt ? formatDate(ctx.order.latestShipment.expectedDeliveryAt) : null),
};

/**
 * A template may print the currency sign itself ("Order amount: ₹{{amount}}", as the approved prepaid_template does). The amount
 * variables resolve to a formatted value WITH its sign ("₹449"), so the customer would read "₹₹449". For each value that starts with a
 * currency sign that the template body ALREADY prints directly before that placeholder, the sign is dropped from the value only.
 * Templates that do not print the sign themselves are untouched.
 */
export function withoutRepeatedCurrencySign(body: string, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const sign = Object.values(CURRENCY_SYMBOLS).find((s) => value.startsWith(s));
    out[name] = sign && body.includes(`${sign}{{${name}}}`) ? value.slice(sign.length).trimStart() : value;
  }
  return out;
}

/** The variable names this CRM can currently resolve, for the frontend to explain what a template needs. */
export const RESOLVABLE_VARIABLES = Object.keys(REGISTRY);
/** Variables that only ever resolve from order data - used to decide whether order selection is required. */
export const ORDER_ONLY_VARIABLES = new Set(["order_number", "product_name", "order_status", "order_amount", "product_summary", "amount", "outstanding_amount", "payment_status", "payment_link", "payment_amount", "tracking_number", "tracking_url", "courier", "shipment_status", "shipped_date", "delivery_date", "expected_delivery_date"]);

export interface VariableResolutionResult {
  values: Record<string, string>;
  errors: string[];
  /** One entry per requested variable, in order - the single shared source of truth for how the Send WhatsApp UI,
   *  bulk send review, and the backend all agree on what a template needs. `source: "crm"` means this CRM can
   *  resolve it automatically from the lead/order (customer_name, order_number, ...); `source: "manual"` means no
   *  automatic source exists for a variable with this name - it is a normal, real variable of THIS template (every
   *  name here always comes from that template's own body), just one only a person can supply a value for (e.g. a
   *  one-off campaign detail like webinar_name). Never "unknown": a variable's name is only ever taken from the
   *  template it belongs to. */
  fields: TemplateVariableField[];
}

export type VariableSource = "crm" | "manual";

export interface TemplateVariableField {
  name: string;
  source: VariableSource;
  /** The resolved value - from CRM data for `source: "crm"`, from `manualValues` for `source: "manual"` - or null
   *  when nothing is available yet (a CRM variable with no order selected, or a manual variable nobody has typed a
   *  value for). */
  value: string | null;
}

/** Whether this CRM has ANY automatic data source for a variable with this name - independent of whether a value
 *  is actually available for a specific lead/order right now. Used by the frontend (and this module) to label a
 *  field "Auto-filled" vs "Required input" before a value is even computed. */
export function classifyVariable(name: string): VariableSource {
  return name in REGISTRY ? "crm" : "manual";
}

/** `manualValues` supplies a value for any variable by name - normally used for the ones with no CRM source
 *  (`source: "manual"`), but a manually-typed value always wins even for a CRM-resolvable one (a person can
 *  override an auto-filled value before sending), matching the Send WhatsApp UI's own editable fields. */
export function resolveTemplateVariables(variableNames: string[], ctx: VariableResolutionContext, manualValues: Record<string, string> = {}): VariableResolutionResult {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const fields: TemplateVariableField[] = [];

  for (const name of variableNames) {
    const manual = manualValues[name]?.trim();
    const source = classifyVariable(name);
    const resolved = manual ? manual : source === "crm" ? REGISTRY[name]!(ctx) : null;

    if (resolved === null || resolved === "") {
      errors.push(`Value required for ${name}`);
      fields.push({ name, source, value: null });
      continue;
    }
    values[name] = resolved;
    fields.push({ name, source, value: resolved });
  }

  return { values, errors, fields };
}
