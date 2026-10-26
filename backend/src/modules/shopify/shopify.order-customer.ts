import { logger } from "@/utils/logger.js";
import { listCustomersForDisplay } from "./shopify.customers.js";
import { isGeneratedEmail, verifiedCustomers } from "../abandonment/abandonment.shopify-history.js";
import { normalizeEmail } from "@/lib/leadIdentity.js";
import { splitName } from "./shopify.order-mapping.js";
import type { ShopifyClient } from "./shopify.client.js";
import type { ShopifyOrderCustomer } from "./shopify.orders.write.js";
import { createShopifyCustomer, fillShopifyCustomerName, type CustomerNames } from "./shopify.customers.write.js";

// Decides which Shopify customer a CRM order belongs to - the same verified-identity policy the lead's order history uses: a customer is the same person only on a phone that normalises to the lead's, or on the
// lead's REAL e-mail (never a generated checkout one). Names and addresses alone never match. When two different customers match, nothing is guessed.

export interface CustomerDecision {
  customer: ShopifyOrderCustomer | null;
  /** Why no association was made (shown in the sync result), or what was done. */
  note: string;
  /**
   * Shopify customer writes the push must make BEFORE the order is created (see materializeShopifyCustomer). The decision itself is read-only so previews and repairs never write.
   *  create   - a lead with a phone but no e-mail and no verified Shopify customer: orderCreate cannot create a customer from a phone alone, so the customer is created first and associated;
   *  fillName - a verified Shopify customer that has no name: the CRM name is set (an existing name is never overwritten).
   */
  ensure?: { create?: { phone: string; email: string | null } & CustomerNames; fillName?: { id: string } & CustomerNames };
}

const PLACEHOLDER_FIRST = /^shiprocket checkout lead$/i;
/** A placeholder first name the checkout feed gives a lead that never captured a real name. */
export const isPlaceholderLeadName = (firstName: string): boolean => PLACEHOLDER_FIRST.test(firstName.trim());

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
    const hasName = Boolean(names.firstName || names.lastName);
    if (found.length === 1) {
      const blank = !found[0]!.name?.trim();
      return { customer: { toAssociate: { id: found[0]!.id } }, note: "associated with the verified existing Shopify customer", ...(blank && hasName ? { ensure: { fillName: { id: found[0]!.id, ...names } } } : {}) };
    }
    if (!upsert) {
      // Shopify identifies a NEW customer in orderCreate by e-mail only, so a phone-only lead used to get NO Shopify customer - and therefore no customer name on the order. The customer is created from the phone first.
      if (lead.normalizedMobile && hasName) return { customer: null, note: "no Shopify customer matched this phone; one is created from the CRM name and phone", ensure: { create: { phone: lead.normalizedMobile, email: null, ...names } } };
      return { customer: null, note: "the lead has no e-mail, so no new Shopify customer is created (Shopify identifies a new customer by e-mail, not phone); the order carries the phone number" };
    }
    return { customer: upsert, note: "no existing Shopify customer matched; a customer with the CRM name, e-mail and phone is created" };
  } catch (error) {
    logger.error("Shopify customer lookup failed", error instanceof Error ? error.message : String(error));
    return { customer: null, note: "the Shopify customer lookup failed, so the order carries the e-mail and phone only" };
  }
}

/**
 * Carries out the Shopify customer writes a decision asks for, just before the order is created. Best effort: a Shopify refusal is reported in the returned note and the order is still created (with the phone, e-mail and
 * the recipient name on its addresses) - a customer problem must never block or drop the order's charges. Returns the association to put on the order (null = none) and the note to record.
 */
const NL = String.fromCharCode(10);
export const isPhoneTakenError = (error: unknown) => error instanceof Error && /(phone|number).{0,40}(already been taken|already exists|already in use)|already been taken/i.test(error.message);
const pause = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Looks the phone up again after Shopify refused to create a duplicate. Shopify's search index can lag a few seconds behind a just-created customer, so it asks twice. */
export async function findCustomerByPhone(client: Pick<ShopifyClient, "query">, phone: string, retryDelayMs: number): Promise<{ id: string; name: string | null }[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await pause(retryDelayMs);
    const page = await listCustomersForDisplay(client as ShopifyClient, { first: 5, search: `phone:"${phone}"` });
    const found = verifiedCustomers({ normalizedMobile: phone, normalizedEmail: null }, page.items);
    if (found.length > 0) return found.map((c) => ({ id: c.id, name: c.name }));
  }
  return [];
}

export async function materializeShopifyCustomer(client: Pick<ShopifyClient, "query">, decision: CustomerDecision, opts: { retryDelayMs?: number } = {}): Promise<{ customer: ShopifyOrderCustomer | null; note: string; wrote: string[] }> {
  const wrote: string[] = [];
  const { ensure } = decision;
  if (!ensure) return { customer: decision.customer, note: decision.note, wrote };
  if (ensure.create) {
    try {
      const made = await createShopifyCustomer(client, ensure.create);
      wrote.push("customer created");
      return { customer: { toAssociate: { id: made.id } }, note: "a Shopify customer was created from the CRM name and phone and associated with the order", wrote };
    } catch (error) {
      // "Phone has already been taken": the customer exists (made by an earlier attempt, a parallel request, or Shopify itself). Never create a second one - find it and use it, if it is exactly one verified match.
      if (isPhoneTakenError(error)) {
        try {
          const existing = await findCustomerByPhone(client, ensure.create.phone, opts.retryDelayMs ?? 1500);
          if (existing.length === 1) {
            const only = existing[0]!;
            const out = { customer: { toAssociate: { id: only.id } } as ShopifyOrderCustomer, note: "Shopify already had a customer with this phone (creation was refused as a duplicate); that customer was associated with the order", wrote };
            if (!only.name?.trim()) {
              try {
                await fillShopifyCustomerName(client, only.id, ensure.create);
                wrote.push("customer name set");
              } catch {
                out.note += "; its name could not be set";
              }
            }
            return out;
          }
          if (existing.length > 1) return { customer: null, note: `${existing.length} different Shopify customers match this phone; none was attached to avoid mixing customers`, wrote };
        } catch (lookupError) {
          logger.warn(`Shopify customer re-lookup failed: ${lookupError instanceof Error ? lookupError.message.split(NL)[0] : "unknown error"}`);
        }
        return { customer: null, note: "Shopify says a customer with this phone already exists but it could not be found yet, so none was attached (and none was duplicated); the order carries the phone and the recipient name on its address - associate it in Shopify if needed", wrote };
      }
      logger.warn(`Shopify customer create failed: ${error instanceof Error ? error.message.split(NL)[0] : "unknown error"}`);
      return { customer: null, note: `the Shopify customer could not be created (${error instanceof Error ? error.message.split(NL)[0]!.slice(0, 160) : "error"}); the order carries the phone number and the recipient name on its address`, wrote };
    }
  }
  if (ensure.fillName) {
    try {
      await fillShopifyCustomerName(client, ensure.fillName.id, ensure.fillName);
      wrote.push("customer name set");
    } catch (error) {
      logger.warn(`Shopify customer name update failed: ${error instanceof Error ? error.message.split(NL)[0] : "unknown error"}`);
      return { customer: decision.customer, note: `${decision.note}; the customer's name could not be set in Shopify (${error instanceof Error ? error.message.split(NL)[0]!.slice(0, 120) : "error"})`, wrote };
    }
  }
  return { customer: decision.customer, note: decision.note, wrote };
}
