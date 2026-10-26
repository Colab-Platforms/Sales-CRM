// AUDIT of CRM-created orders against the Shopify orders they were pushed as. Pure classification (no I/O) so the rules are tested; the read-only script that feeds it is src/scripts/shopify-order-audit.ts.
//
// Two kinds of discrepancy, with different repair rules:
//   MONEY     the CRM total differs from Shopify's. NEVER repaired automatically: making them agree means an order edit (a line, a shipping line, a discount) that changes what the customer owes, which may already be
//             collected, refunded or on a courier's COD sheet. These are listed with the likely cause for a person to decide.
//   CUSTOMER  the CRM knows the customer's name but the Shopify order has no customer, or its customer has no name. Repairing it (link an existing verified customer, create one, fill a blank name) changes no
//             amount, payment, fulfilment or shipment - and is still only done automatically when the order is otherwise clean (see reviewReasons).
import { isPlaceholderLeadName } from "./shopify.order-customer.js";
import { addressDifferences, type AddressParts } from "./shopify.order-sync.compare.js";

export interface AuditCrmOrder {
  id: string;
  orderNumber: string;
  externalId: string;
  externalNumber: string | null;
  status: string;
  currency: string;
  totalCents: number;
  shippingCents: number;
  discountCents: number;
  taxCents: number;
  paymentStatuses: string[];
  paymentMode: string | null;
  shipmentCount: number;
  refundRequestCount: number;
  lead: { id: string; firstName: string; lastName: string | null; normalizedMobile: string | null; email: string | null };
  /** The CRM shipping address record (lines, city, state, pincode, name), when loaded. */
  address?: AddressParts | null;
}

export interface AuditShopifyOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string | null;
  totalCents: number;
  currentTotalCents: number;
  shippingCents: number;
  discountsCents: number;
  taxCents: number;
  refundedCents: number;
  customer: { id: string; firstName: string | null; lastName: string | null; phone: string | null } | null;
  /** Shopify's shipping address, when loaded. */
  address?: AddressParts | null;
}

export type MoneyKind = "SHIPPING_MISSING_IN_SHOPIFY" | "DISCOUNT_NOT_IN_SHOPIFY" | "TAX_DIFFERENCE" | "LINE_OR_PRICE_DIFFERENCE";
export type CustomerIssue = "NO_CUSTOMER" | "CUSTOMER_NAME_MISSING";
export type RepairPlan = "NONE" | "LINK_OR_CREATE_CUSTOMER" | "FILL_CUSTOMER_NAME" | "MANUAL_REVIEW";

export interface AuditResult {
  crmOrderId: string;
  shopifyOrderId: string;
  orderName: string | null;
  crmTotalCents: number;
  shopifyTotalCents: number;
  differenceCents: number;
  money: { kind: MoneyKind; reason: string } | null;
  customerIssue: CustomerIssue | null;
  /** Why this order must not be repaired automatically (empty = clean enough for the customer repair). */
  reviewReasons: string[];
  repair: RepairPlan;
  /** The shipping address differs between the CRM and Shopify (only when both were loaded). */
  addressDiffers: boolean;
}

export const crmHasCustomerName = (lead: AuditCrmOrder["lead"]): boolean => Boolean(lead.firstName.trim()) && !isPlaceholderLeadName(lead.firstName);
const blank = (v: string | null | undefined) => !v || !v.trim();

/** What most likely explains a total that differs, judged from the CRM's own breakdown against Shopify's. Never a guess about causes outside the money fields. */
export function explainMoney(crm: AuditCrmOrder, shop: AuditShopifyOrder): { kind: MoneyKind; reason: string } | null {
  const diff = crm.totalCents - shop.totalCents;
  if (diff === 0) return null;
  // Shopify edited after creation (a prepaid upgrade or order edit): its CURRENT total can equal the CRM total even though the original differs.
  if (crm.totalCents === shop.currentTotalCents) return null;
  const money = (c: number) => (c / 100).toFixed(2);
  if (crm.shippingCents > 0 && shop.shippingCents === 0 && diff === crm.shippingCents) return { kind: "SHIPPING_MISSING_IN_SHOPIFY", reason: `the CRM charges shipping ${money(crm.shippingCents)} that the Shopify order has no shipping line for` };
  if (crm.discountCents > 0 && shop.discountsCents === 0 && diff === -crm.discountCents) return { kind: "DISCOUNT_NOT_IN_SHOPIFY", reason: `the CRM discount ${money(crm.discountCents)} is not on the Shopify order` };
  if (crm.taxCents !== shop.taxCents && Math.abs(diff) === Math.abs(crm.taxCents - shop.taxCents)) return { kind: "TAX_DIFFERENCE", reason: `tax differs (CRM ${money(crm.taxCents)}, Shopify ${money(shop.taxCents)})` };
  return { kind: "LINE_OR_PRICE_DIFFERENCE", reason: `the totals differ by ${money(Math.abs(diff))} and no shipping, discount or tax figure accounts for it - the line items or prices differ` };
}

export function classifyOrder(crm: AuditCrmOrder, shop: AuditShopifyOrder): AuditResult {
  const money = explainMoney(crm, shop);
  const named = crmHasCustomerName(crm.lead);
  let customerIssue: CustomerIssue | null = null;
  if (named) {
    if (!shop.customer) customerIssue = "NO_CUSTOMER";
    else if (blank(shop.customer.firstName) && blank(shop.customer.lastName)) customerIssue = "CUSTOMER_NAME_MISSING";
  }

  const review: string[] = [];
  if (shop.cancelledAt || crm.status === "CANCELLED") review.push("cancelled");
  if (shop.fulfillmentStatus && shop.fulfillmentStatus !== "UNFULFILLED") review.push(`fulfilment: ${shop.fulfillmentStatus.toLowerCase()}`);
  if (crm.shipmentCount > 0) review.push("a shipment exists");
  if (shop.refundedCents > 0 || crm.refundRequestCount > 0 || crm.paymentStatuses.some((s) => s === "REFUNDED" || s === "PARTIALLY_REFUNDED")) review.push("refund");
  if (money) review.push(`money: ${money.kind.toLowerCase().replace(/_/g, " ")}`);
  const paidInCrm = crm.paymentStatuses.includes("SUCCESS");
  const paidInShopify = /^(paid|partially_paid)$/i.test(shop.financialStatus ?? "");
  if (paidInCrm !== paidInShopify) review.push(`payment state differs (CRM ${paidInCrm ? "paid" : "unpaid"}, Shopify ${shop.financialStatus?.toLowerCase() ?? "unknown"})`);
  if (shop.currency && shop.currency !== crm.currency) review.push("currency differs");

  let repair: RepairPlan = "NONE";
  if (customerIssue) repair = review.length === 0 ? (customerIssue === "NO_CUSTOMER" ? "LINK_OR_CREATE_CUSTOMER" : "FILL_CUSTOMER_NAME") : "MANUAL_REVIEW";
  else if (money) repair = "MANUAL_REVIEW";
  const addressDiffers = crm.address !== undefined && shop.address !== undefined ? addressDifferences(crm.address, shop.address).length > 0 : false;
  return { addressDiffers, crmOrderId: crm.id, shopifyOrderId: shop.id, orderName: shop.name, crmTotalCents: crm.totalCents, shopifyTotalCents: shop.totalCents, differenceCents: crm.totalCents - shop.totalCents, money, customerIssue, reviewReasons: review, repair };
}
