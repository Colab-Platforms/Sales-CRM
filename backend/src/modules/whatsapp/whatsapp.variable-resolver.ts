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
}

export interface ResolverOrderContext {
  orderNumber: string;
  externalNumber: string | null;
  status: string;
  currency: string;
  totalAmount: string;
  payments: ResolverPaymentContext[];
  latestShipment: ResolverShipmentContext | null;
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

/** null = this variable is meaningful but not available in the given context (e.g. no order, no shipment yet). */
type Resolver = (ctx: VariableResolutionContext) => string | null;

const REGISTRY: Record<string, Resolver> = {
  customer_name: (ctx) => fullName(ctx.lead.firstName, ctx.lead.lastName),
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

  tracking_number: (ctx) => ctx.order?.latestShipment?.trackingNumber ?? null,
  tracking_url: (ctx) => ctx.order?.latestShipment?.trackingUrl ?? null,
  courier: (ctx) => ctx.order?.latestShipment?.courier ?? null,
  shipment_status: (ctx) => (ctx.order?.latestShipment ? humanize(ctx.order.latestShipment.status) : null),
  shipped_date: (ctx) => (ctx.order?.latestShipment?.shippedAt ? formatDate(ctx.order.latestShipment.shippedAt) : null),
  delivery_date: (ctx) => (ctx.order?.latestShipment?.deliveredAt ? formatDate(ctx.order.latestShipment.deliveredAt) : null),
  expected_delivery_date: (ctx) => (ctx.order?.latestShipment?.expectedDeliveryAt ? formatDate(ctx.order.latestShipment.expectedDeliveryAt) : null),
};

/** The variable names this CRM can currently resolve, for the frontend to explain what a template needs. */
export const RESOLVABLE_VARIABLES = Object.keys(REGISTRY);
/** Variables that only ever resolve from order data - used to decide whether order selection is required. */
export const ORDER_ONLY_VARIABLES = new Set(["order_number", "order_status", "order_amount", "outstanding_amount", "payment_status", "tracking_number", "tracking_url", "courier", "shipment_status", "shipped_date", "delivery_date", "expected_delivery_date"]);

export interface VariableResolutionResult {
  values: Record<string, string>;
  errors: string[];
}

export function resolveTemplateVariables(variableNames: string[], ctx: VariableResolutionContext): VariableResolutionResult {
  const values: Record<string, string> = {};
  const errors: string[] = [];

  for (const name of variableNames) {
    const resolver = REGISTRY[name];
    if (!resolver) {
      errors.push(`Unknown template variable: ${name}`);
      continue;
    }
    const value = resolver(ctx);
    if (value === null || value === "") {
      errors.push(`Missing value for variable: ${name}`);
      continue;
    }
    values[name] = value;
  }

  return { values, errors };
}
