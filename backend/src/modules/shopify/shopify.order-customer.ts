import { logger } from "@/utils/logger.js";
import { listCustomersForDisplay } from "./shopify.customers.js";
import { isGeneratedEmail, verifiedCustomers } from "../abandonment/abandonment.shopify-history.js";
import { normalizeEmail } from "@/lib/leadIdentity.js";
import { splitName } from "./shopify.order-mapping.js";
import type { ShopifyClient } from "./shopify.client.js";
import type { ShopifyOrderCustomer } from "./shopify.orders.write.js";

// Decides which Shopify customer a CRM order belongs to - the same verified-identity policy the lead's order history uses: a customer is the same person only on a phone that normalises to the lead's, or on the
// lead's REAL e-mail (never a generated checkout one). Names and addresses alone never match. When two different customers match, nothing is guessed.

export interface CustomerDecision {
  customer: ShopifyOrderCustomer | null;
  /** Why no association was made (shown in the sync result), or what was done. */
  note: string;
}

const PLACEHOLDER_FIRST = /^shiprocket checkout lead$/i;

/** The customer's name: the lead's own; when the lead never captured a real one (checkout placeholder) or only a first name, the name typed into the delivery address if it begins with it. */
export function customerNames(lead: { firstName: string; lastName: string | null }, addressName: string | null | undefined): { firstName: string; lastName: string } {
  const full = splitName(addressName ?? "");
  const addressFull = (addressName ?? "").trim().replace(/\s+/g, " ");
  if (PLACEHOLDER_FIRST.test(lead.firstName.trim()) && addressFull) return { firstName: full.first, lastName: full.last };
  if (!lead.lastName && addressFull.toLowerCase().startsWith(`${lead.firstName.trim().toLowerCase()} `)) return { firstName: lead.firstName.trim(), lastName: addressFull.slice(lead.firstName.trim().length).trim() };
  return { firstName: lead.firstName.trim(), lastName: (lead.lastName ?? "").trim() };
}

export async function resolveShopifyCustomer(
  client: Pick<ShopifyClient, "query">,
  lead: { firstName: string; lastName: string | null; email: string | null; normalizedMobile: string | null },
  addressName: string | null | undefined,
): Promise<CustomerDecision> {
  const email = lead.email ? normalizeEmail(lead.email) : null;
  const realEmail = email && !isGeneratedEmail(email, lead.normalizedMobile) ? email : null;
  const names = customerNames(lead, addressName);
  // Shopify identifies a NEW customer by e-mail when no id is given (OrderCreateUpsertCustomerAttributesInput.email); a phone alone is refused and takes the whole order down with it. So a customer is created only
  // from a lead that has an e-mail; a lead without one is matched on its phone (above) or simply not attached - the order still carries the phone number.
  const upsert: ShopifyOrderCustomer | null = !lead.email?.trim() ? null : { toUpsert: { ...(lead.email ? { email: lead.email.trim() } : {}), ...(lead.normalizedMobile ? { phone: lead.normalizedMobile } : {}), ...(names.firstName ? { firstName: names.firstName } : {}), ...(names.lastName ? { lastName: names.lastName } : {}) } };
  const terms: string[] = [];
  if (lead.normalizedMobile) terms.push(`phone:"${lead.normalizedMobile}"`);
  if (realEmail) terms.push(`email:"${realEmail}"`);
  if (terms.length === 0) return { customer: null, note: "the lead has no phone or real e-mail to match a Shopify customer on" };
  try {
    const found = verifiedCustomers({ normalizedMobile: lead.normalizedMobile, normalizedEmail: email }, (await listCustomersForDisplay(client as ShopifyClient, { first: 5, search: terms.join(" OR ") })).items);
    if (found.length > 1) return { customer: null, note: `${found.length} different Shopify customers match this lead's phone/e-mail; none was attached to avoid mixing customers` };
    if (found.length === 1) return { customer: { toAssociate: { id: found[0]!.id } }, note: "associated with the verified existing Shopify customer" };
    if (!upsert) return { customer: null, note: "the lead has no e-mail, so no new Shopify customer is created (Shopify identifies a new customer by e-mail, not phone); the order carries the phone number" };
    return { customer: upsert, note: "no existing Shopify customer matched; a customer with the CRM name, e-mail and phone is created" };
  } catch (error) {
    logger.error("Shopify customer lookup failed", error instanceof Error ? error.message : String(error));
    return { customer: null, note: "the Shopify customer lookup failed, so the order carries the e-mail and phone only" };
  }
}
