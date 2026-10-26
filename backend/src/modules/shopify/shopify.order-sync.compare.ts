import { createHash } from "node:crypto";
import { provinceCodeFor, splitName } from "./shopify.order-mapping.js";

// THE FIELD MAP for "Sync / Update from CRM": one explicit table saying, for every field the CRM and a Shopify order both carry, who owns it and whether the sync may write it. Pure rules, no I/O.
//
//  field                      source of truth   sync writes it?                                                    why
//  customer link              CRM (lead)        YES  link / create the Shopify customer (non-financial)           the order must belong to the customer the CRM sold to
//  customer name              CRM (lead)        YES  only when the Shopify customer has NO name                   an existing Shopify name is Shopify-owned: never overwritten
//  customer phone / e-mail    Shopify customer  NO   reported only                                                one Shopify customer spans many orders; the CRM does not edit it here
//  shipping address           CRM               YES  open orders only (unfulfilled, not cancelled, no shipment)   orderUpdate; read back and verified; billing address is not touched (Shopify's orderUpdate cannot set it)
//  billing address            -                 NO   reported only                                                the CRM keeps no separate billing address
//  tags                       CRM               YES  ADD-ONLY (CRM, source, "Order Created by ...")               existing Shopify tags are never removed or changed
//  line items / variants      Shopify order     NO   reported; flavour swaps have their own action               changing a line is an ORDER EDIT that can change what the customer owes
//  shipping line, discount    Shopify order     NO   reported; manual review                                      changes the amount owed (may already be on a courier COD sheet)
//  total, tax, payment state  Shopify order     NO   reported; manual review                                      financial; never forced to match
//  fulfilment, cancellation   Shopify          NO   reported (it decides what is editable)                        never changed by a sync

export type SyncGroup = "customer" | "address" | "order" | "financial" | "state";
export type SyncStatus = "SYNCED" | "DIFFERENT" | "INFO";
export type SyncActionId = "customer.link" | "customer.name" | "shipping.address" | "tags.add";
export const SYNC_ACTIONS: readonly SyncActionId[] = ["customer.link", "customer.name", "shipping.address", "tags.add"];

export interface SyncItem {
  key: string;
  group: SyncGroup;
  label: string;
  crm: string | null;
  shopify: string | null;
  status: SyncStatus;
  /** Set when the sync may write this difference (and the order state allows it). */
  action: SyncActionId | null;
  /** Why a DIFFERENT item cannot be synced automatically (null when it can, or when it is in sync). */
  blocked: string | null;
}

export interface AddressParts {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  provinceCode?: string | null;
  pincode?: string | null;
  phone?: string | null;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const low = (v: unknown) => clean(v).toLowerCase();

/** The comparable form of a CRM address record or a Shopify mailing address: lines, city, province code, PIN and the recipient's name (as one lower-case string, so "Anil Kumar" == first "Anil" + last "Kumar"). */
export function comparableAddress(a: AddressParts | null | undefined) {
  if (!a) return null;
  const fullName = clean(a.name) || [clean(a.firstName), clean(a.lastName)].filter(Boolean).join(" ");
  const code = clean(a.provinceCode) || provinceCodeFor(clean(a.state)) || "";
  return { name: low(fullName), line1: low(a.line1), line2: low(a.line2), city: low(a.city), province: code.toUpperCase(), pincode: clean(a.pincode) };
}

/** Which parts of the shipping address differ (empty = the same). The recipient name is only compared when the CRM has one; a blank CRM line never counts as a difference from a Shopify value. */
export function addressDifferences(crm: AddressParts | null | undefined, shopify: AddressParts | null | undefined): string[] {
  const a = comparableAddress(crm);
  const b = comparableAddress(shopify);
  if (!a) return [];
  if (!b) return ["no shipping address in Shopify"];
  const out: string[] = [];
  const same = (x: string, y: string) => x === y;
  if (a.line1 && !same(a.line1, b.line1)) out.push("address line 1");
  if (a.line2 && !same(a.line2, b.line2)) out.push("address line 2");
  if (a.city && !same(a.city, b.city)) out.push("city");
  if (a.province && !same(a.province, b.province)) out.push("state");
  if (a.pincode && !same(a.pincode, b.pincode)) out.push("PIN code");
  if (a.name) {
    const split = splitName(a.name);
    const bn = b.name.replace(/\s+/g, " ");
    // Shopify's recipient may be stored as a single last name (one-word recipients) - equal ignoring the first/last split
    if (bn !== a.name && bn !== `${split.last}`.toLowerCase() && bn.replace(/\s+/g, "") !== a.name.replace(/\s+/g, "")) out.push("recipient name");
  }
  return out;
}

export const addressText = (a: AddressParts | null | undefined): string | null => {
  const c = comparableAddress(a);
  if (!c) return null;
  const parts = [clean(a!.name) || [clean(a!.firstName), clean(a!.lastName)].filter(Boolean).join(" "), clean(a!.line1), clean(a!.line2), clean(a!.city), clean(a!.provinceCode) || clean(a!.state), clean(a!.pincode)].filter(Boolean);
  return parts.join(", ") || null;
};

/** A stable fingerprint of what the preview compared. The apply step recomputes it and refuses to proceed if either system changed in between. */
export const stateToken = (snapshot: unknown): string => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 32);

// ------------------------------------------------------------------------------------------------ report categories
export type SyncCategory = "SYNCED" | "SAFE_CUSTOMER" | "SAFE_ADDRESS" | "FINANCIAL" | "CONFLICT" | "AMBIGUOUS_CUSTOMER";
export const SYNC_CATEGORY_LABEL: Record<SyncCategory, string> = {
  SYNCED: "Already synchronized",
  SAFE_CUSTOMER: "Safe customer link / name repair",
  SAFE_ADDRESS: "Safe address update",
  FINANCIAL: "Financial mismatch - manual review",
  CONFLICT: "Payment / refund / fulfilment / shipment conflict - manual review",
  AMBIGUOUS_CUSTOMER: "Customer match failed or ambiguous - manual review",
};

/**
 * The one bucket an audited order belongs in. An order with no difference at all is SYNCED whatever its state (a cancelled or fulfilled order that already agrees is fine). Otherwise a money difference outranks
 * everything (it is what a person must decide); then a payment-state difference or any restricted state (cancelled, fulfilled, shipment, refund) -> CONFLICT; then the safe repairs.
 */
export function categoryOf(r: { money: unknown; customerIssue: string | null; reviewReasons: string[]; addressDiffers?: boolean }): SyncCategory {
  const paymentConflict = r.reviewReasons.some((x) => x.startsWith("payment state") || x === "currency differs");
  if (!r.money && !r.customerIssue && !r.addressDiffers && !paymentConflict) return "SYNCED";
  if (r.money) return "FINANCIAL";
  if (r.reviewReasons.length > 0) return "CONFLICT";
  return r.customerIssue ? "SAFE_CUSTOMER" : "SAFE_ADDRESS";
}
