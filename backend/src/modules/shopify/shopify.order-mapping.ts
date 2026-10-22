// ONE mapping layer from a CRM order to Shopify's orderCreate input. Every CRM order that is pushed to Shopify (WhatsApp Inbox / Create Order, lead page, abandoned checkout, the AI order conversation, a
// manual retry) goes through pushOrderToShopify -> buildShopifyOrderPayload, so a field is fixed here once. Pure functions only: no I/O, no secrets.
//
// FIELD CHECKLIST (CRM source -> Shopify field)                                          required?
//  items[].variant.externalId / product name     -> lineItems[].variantId / title        required
//  items[].quantity, unitPrice                    -> lineItems[].quantity, priceSet       required
//  physical product (not a service)               -> lineItems[].requiresShipping = true   required for physical goods (Shopify's default for a created order is false)
//  order.discountAmount (+ reason)                -> discountCode.itemFixedDiscountCode    optional (only when the CRM figures add up)
//  order.shippingAmount                           -> shippingLines[]                       optional (same condition)
//  payment status (SUCCESS = PAID, else PENDING)  -> financialStatus                       required (a pending payment link stays PENDING)
//  lead name / email / phone                      -> customer (toAssociate | toUpsert), email, phone   optional
//  shippingAddress{name,line1,line2,city,state,pincode,phone}
//                                                  -> shippingAddress{firstName,lastName,address1,address2,city,provinceCode,zip,countryCode,phone}   required when the CRM has one
//  (the CRM keeps no separate billing address)    -> billingAddress = the shipping address  optional
//  landmark, delivery instructions, address type, house number -> note + crm.* metafields (MailingAddressInput has no field for them; line2 already carries the landmark)
//  order number / lead number / creator / source / payment method / discount reason -> note, tags, crm.* metafields
//  order number                                    -> sourceIdentifier                      required (idempotent retries)
// Not transferred (and why): payment references / links (never put in public fields - they stay in the CRM), internal audit trail (CRM audit records), line-item level discounts (the CRM applies the discount at order level).
import type { ShopifyOrderCreateInput, ShopifyOrderCreateAddress, ShopifyOrderMetafield } from "./shopify.orders.write.js";
import { creatorTagFor } from "../orders/orders.creator-tag.js";

/** Shopify's province codes for India, taken from the codes the store's own orders carry (Odisha is OR, Telangana TS, Uttarakhand UK). */
const PROVINCE_CODES: Record<string, string> = {
  "andaman and nicobar islands": "AN", "andhra pradesh": "AP", "arunachal pradesh": "AR", assam: "AS", bihar: "BR", chandigarh: "CH", chhattisgarh: "CG", delhi: "DL", "new delhi": "DL", goa: "GA", gujarat: "GJ", haryana: "HR",
  "himachal pradesh": "HP", "jammu and kashmir": "JK", jharkhand: "JH", karnataka: "KA", kerala: "KL", ladakh: "LA", lakshadweep: "LD", "madhya pradesh": "MP", maharashtra: "MH", manipur: "MN", meghalaya: "ML", mizoram: "MZ",
  nagaland: "NL", odisha: "OR", orissa: "OR", puducherry: "PY", pondicherry: "PY", punjab: "PB", rajasthan: "RJ", sikkim: "SK", "tamil nadu": "TN", telangana: "TS", tripura: "TR", "uttar pradesh": "UP", uttarakhand: "UK",
  uttaranchal: "UK", "west bengal": "WB",
};

export function provinceCodeFor(state: string | null | undefined): string | undefined {
  const key = (state ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return undefined;
  if (/^[A-Z]{2}$/.test((state ?? "").trim())) return (state ?? "").trim();
  return PROVINCE_CODES[key];
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/** "Asha Rao Verma" -> { first: "Asha Rao", last: "Verma" }; a single word is only a first name. */
export function splitName(full: string): { first: string; last: string } {
  const parts = text(full).split(" ").filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1]! };
}

export interface CrmOrderForShopify {
  orderNumber: string;
  currency: string;
  subtotal: string;
  discountAmount: string;
  discountReason: string | null;
  shippingAmount: string;
  taxAmount: string;
  totalAmount: string;
  shippingAddress: Record<string, unknown> | null;
  shippingPincode: string | null;
  metadata: Record<string, unknown> | null;
  paymentMethod: string | null;
  paymentSucceeded: boolean;
  /** A prepaid order: the Shopify order is created UNPAID and then marked paid by the verified-payment step (mark-as-paid records the Cashfree payment), never created as paid. */
  settleAfterCreate?: boolean;
  /** true when the order came from the AI order conversation. */
  fromAiConversation: boolean;
  lead: { firstName: string; lastName: string | null; leadNumber: string; email: string | null; normalizedMobile: string | null; mobile: string | null };
  items: { quantity: number; unitPrice: string; productName: string; variantName: string | null; sku: string | null; shopifyVariantId: string | null; physical: boolean; /** A free-form (custom) line: no product / variant, sent to Shopify as a custom line item. */ custom?: boolean; taxable?: boolean | null; weightGrams?: string | null }[];
}

export type FieldOutcome = "sent" | "omitted";
export interface MappingReport {
  /** field -> why it was not sent (or "" for sent). Nothing populated in the CRM is dropped without an entry here. */
  fields: Record<string, { outcome: FieldOutcome; reason?: string }>;
}

const sent = (r: MappingReport, field: string) => { r.fields[field] = { outcome: "sent" }; };
const omitted = (r: MappingReport, field: string, reason: string) => { r.fields[field] = { outcome: "omitted", reason }; };

/** Where the order came from, in words a person reading the Shopify order understands. */
export function orderSourceLabel(order: Pick<CrmOrderForShopify, "metadata" | "fromAiConversation">): { label: string; tag: string } {
  const meta = order.metadata ?? {};
  if (order.fromAiConversation) return { label: "WhatsApp AI order conversation", tag: "CRM Source: WhatsApp AI" };
  if (meta.abandonment && typeof meta.abandonment === "object") return { label: "Abandoned checkout (created from the Abandoned Leads page)", tag: "CRM Source: Abandoned Checkout" };
  if (meta.createdVia === "WHATSAPP_INBOX") return { label: "CRM Create Order (WhatsApp Inbox / lead page)", tag: "CRM Source: WhatsApp Inbox" };
  return { label: "CRM manual order", tag: "CRM Source: Manual" };
}

function creatorName(metadata: Record<string, unknown> | null): string | null {
  const c = metadata?.createdBy;
  if (c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string") return ((c as Record<string, unknown>).name as string).trim() || null;
  return null;
}

export function mapAddress(order: CrmOrderForShopify, report: MappingReport): { shipping: ShopifyOrderCreateAddress | undefined; extras: { landmark: string; instructions: string; addressType: string; houseNumber: string } } {
  const a = order.shippingAddress;
  const extras = { landmark: text(a?.landmark), instructions: text(a?.deliveryInstructions), addressType: text(a?.addressType), houseNumber: text(a?.houseNumber) };
  if (!a) { omitted(report, "shippingAddress", "the CRM order has no shipping address"); return { shipping: undefined, extras }; }
  const named = splitName(text(a.name));
  let first = named.first || order.lead.firstName;
  let last = named.first ? named.last : order.lead.lastName ?? "";
  // ROOT CAUSE of the recurring "order has no address in Shopify": Shopify refuses an address whose LAST name is blank ("Enter a last name"). On orderCreate it does not fail - it silently saves the order WITHOUT
  // any shipping / billing address (and orderUpdate then answers the same error). A recipient with a one-word name ("Radhe") used to be split into firstName = "Radhe", lastName = "" and lost the address.
  // The name is never changed or invented: a single word is sent as the LAST name (the field Shopify requires) and no first name. See also the read-back in shopify.orders.write.ts.
  if (!text(last) && text(first)) {
    last = first;
    first = "";
    omitted(report, "shippingAddress.firstName", "the recipient name is one word, so it is sent as the last name (Shopify refuses an address with a blank last name and would drop the whole address)");
  }
  if (!text(last) && !text(first)) omitted(report, "shippingAddress.name", "the CRM has no recipient name for this address; Shopify requires a last name, so it may not keep the address");
  const state = text(a.state ?? a.province);
  const code = provinceCodeFor(state);
  const zip = text(a.pincode ?? a.zip) || order.shippingPincode || "";
  const address: ShopifyOrderCreateAddress = {
    firstName: first || undefined,
    lastName: last || undefined,
    address1: text(a.line1 ?? a.address1) || undefined,
    address2: text(a.line2 ?? a.address2) || undefined,
    city: text(a.city) || undefined,
    ...(code ? { provinceCode: code } : {}),
    zip: zip || undefined,
    countryCode: "IN",
    phone: text(a.phone) || order.lead.normalizedMobile || undefined,
  };
  sent(report, "shippingAddress");
  if (state && !code) omitted(report, "shippingAddress.province", `"${state}" is not a known Indian state, so no province code was sent (the city and PIN code still are)`);
  return { shipping: address, extras };
}

export interface BuiltPayload {
  input: ShopifyOrderCreateInput;
  report: MappingReport;
}

/**
 * The complete orderCreate input for a CRM order. `figuresMirror` = the CRM's own totals add up (see OrdersService), which is the only case where the discount and shipping lines are sent.
 * `customer` is the already-resolved Shopify customer decision (see resolveShopifyCustomer) - null when no safe association exists.
 */
export function buildShopifyOrderPayload(order: CrmOrderForShopify, opts: { figuresMirror: boolean; customer: ShopifyOrderCreateInput["customer"] | null; customerNote?: string }): BuiltPayload {
  const report: MappingReport = { fields: {} };
  const { shipping, extras } = mapAddress(order, report);
  const source = orderSourceLabel(order);
  const creator = creatorName(order.metadata);
  const discount = Number(order.discountAmount);

  const lineItems = order.items.map((i) => {
    const base = i.shopifyVariantId ? { variantId: i.shopifyVariantId } : { title: i.productName };
    // A CUSTOM item is a Shopify custom line item (title + price + quantity): its taxable flag and optional weight (in grams) ride along. No catalogue product is ever created for it.
    const custom = i.custom ? { taxable: i.taxable === true, ...(i.weightGrams && Number(i.weightGrams) > 0 ? { weight: { value: Number(i.weightGrams), unit: "GRAMS" as const } } : {}) } : {};
    return { ...base, quantity: i.quantity, priceAmount: i.unitPrice, requiresShipping: i.physical, ...custom };
  });
  sent(report, "lineItems");
  if (order.items.some((i) => i.custom && i.taxable === true)) omitted(report, "lineItems.taxable", "custom items flagged taxable are sent with taxable = true; Shopify applies tax only if the shop has tax rates configured, and the read-back does not confirm per-line tax flags");
  if (order.items.some((i) => i.custom && i.weightGrams && Number(i.weightGrams) > 0)) omitted(report, "lineItems.weight", "custom item weights are sent to Shopify, which does not return a line-item weight, so it cannot be verified (the CRM keeps it)");

  const noteParts = [
    `Created in the CRM (${order.orderNumber}) - ${source.label}.`,
    creator ? `Created by ${creator}.` : "",
    discount > 0 ? `Discount ${order.discountAmount}${order.discountReason ? ` (${order.discountReason})` : ""}; amount to collect is ${order.totalAmount}.` : "",
    order.paymentSucceeded ? "" : `Payment is pending${order.paymentMethod === "COD" ? " (cash on delivery)" : " (payment link / prepaid not yet received)"}.`,
    extras.landmark ? `Landmark: ${extras.landmark}.` : "",
    extras.instructions ? `Delivery instructions: ${extras.instructions}.` : "",
  ].filter(Boolean);
  // Shopify caps a note at 5,000 characters; this one is a few hundred, but never let a long instruction break the order.
  const note = noteParts.join(" ").slice(0, 4900);

  const tags = ["CRM", source.tag, ...(creator ? [creatorTagFor(creator)] : [])];
  sent(report, "tags");

  const meta = (key: string, value: string, type: ShopifyOrderMetafield["type"] = "single_line_text_field"): ShopifyOrderMetafield[] => (value ? [{ namespace: "crm", key, value: value.slice(0, 2000), type }] : []);
  const metafields: ShopifyOrderMetafield[] = [
    ...meta("order_number", order.orderNumber),
    ...meta("lead_number", order.lead.leadNumber),
    ...meta("order_source", source.label),
    ...meta("created_by", creator ?? ""),
    ...meta("payment_method", order.paymentMethod ?? ""),
    ...meta("discount_reason", discount > 0 ? order.discountReason ?? "" : ""),
    ...meta("landmark", extras.landmark),
    ...meta("delivery_instructions", extras.instructions, "multi_line_text_field"),
    ...meta("address_type", extras.addressType),
    ...meta("house_number", extras.houseNumber),
  ];
  sent(report, "metafields");

  const email = order.lead.email ? order.lead.email.trim() : "";
  const phone = order.lead.normalizedMobile ?? "";
  if (email) sent(report, "email"); else omitted(report, "email", "the CRM lead has no e-mail");
  if (phone) sent(report, "phone"); else omitted(report, "phone", "the CRM lead has no phone number");
  if (opts.customer) sent(report, "customer"); else omitted(report, "customer", opts.customerNote ?? "no safely verified Shopify customer; the order carries the e-mail and phone instead");

  const input: ShopifyOrderCreateInput = {
    lineItems,
    email: email || undefined,
    phone: phone || undefined,
    currency: order.currency,
    financialStatus: order.paymentSucceeded && !order.settleAfterCreate ? "PAID" : "PENDING",
    note,
    tags,
    metafields,
    ...(shipping ? { shippingAddress: shipping, billingAddress: shipping } : {}),
    ...(opts.customer ? { customer: opts.customer } : {}),
    sourceIdentifier: order.orderNumber,
  };
  if (shipping) sent(report, "billingAddress");
  if (opts.figuresMirror) {
    if (discount > 0) input.discount = { amount: order.discountAmount, description: `CRM discount (${order.orderNumber})` };
    if (Number(order.shippingAmount) > 0) input.shippingAmount = order.shippingAmount;
    sent(report, "discount/shipping");
  } else if (discount > 0 || Number(order.shippingAmount) > 0) {
    omitted(report, "discount/shipping", "the CRM totals do not add up from the items, so the discount/shipping lines were not mirrored (payment reconciliation stays on its safe path)");
  }
  return { input, report };
}
