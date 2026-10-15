import type { Prisma } from "../../../generated/prisma/client.js";
import { isSameCustomer } from "../abandonment/abandonment.customer-context.js";
import { readAddressRecord, type AddressSource, type ResolvedAddress } from "@/lib/addressReader.js";

// ONE place that decides what delivery address to pre-fill for a customer (how a stored address of any shape is READ lives in lib/addressReader.ts). Every manual-order entry point
// (WhatsApp -> Create Order, Lead page -> Create Order, abandoned checkout) goes through here, so a field-name quirk is fixed once.
export { readAddressRecord, cleanPincode, cleanPlace, type AddressSource, type ResolvedAddress } from "@/lib/addressReader.js";

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ResolvedForLead {
  address: ResolvedAddress | null;
  source: AddressSource | null;
  /** The lead the address was read from. Equal to the selected lead unless the same person has another lead record (see isSameCustomer). */
  fromLeadId: string | null;
}

type Db = Pick<Prisma.TransactionClient, "lead" | "order" | "abandonment">;
const ORDERS_TO_CHECK = 10;
const CHECKOUTS_TO_CHECK = 5;

async function fromLead(db: Db, leadId: string): Promise<{ address: ResolvedAddress; source: AddressSource } | null> {
  const orders = await db.order.findMany({ where: { leadId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: ORDERS_TO_CHECK, select: { shippingAddress: true, shippingPincode: true } });
  for (const o of orders) {
    const a = readAddressRecord(o.shippingAddress, o.shippingPincode);
    if (a) return { address: a, source: "ORDER" };
  }
  // No delivered/placed order has an address yet: the address the customer typed at checkout.
  const checkouts = await db.abandonment.findMany({ where: { leadId }, orderBy: [{ detectedAt: "desc" }, { id: "desc" }], take: CHECKOUTS_TO_CHECK, select: { cartSnapshot: true } });
  for (const c of checkouts) {
    const snap = isRec(c.cartSnapshot) ? c.cartSnapshot : null;
    const a = snap ? readAddressRecord(snap.shippingAddress) : null;
    if (a) return { address: a, source: "CHECKOUT" };
  }
  return null;
}

/**
 * The address to pre-fill for the SELECTED lead: its own latest order, then the address it typed at checkout; then - only if that gives nothing - another lead record of the SAME person
 * (same phone with no contradicting name/e-mail, per isSameCustomer). A different customer who merely shares the phone number is never used.
 */
export async function resolveAddressForLead(db: Db, leadId: string): Promise<ResolvedForLead> {
  const own = await fromLead(db, leadId);
  if (own) return { ...own, fromLeadId: leadId };

  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, firstName: true, normalizedMobile: true, normalizedEmail: true } });
  if (!lead || (!lead.normalizedMobile && !lead.normalizedEmail)) return { address: null, source: null, fromLeadId: null };
  const or: Prisma.LeadWhereInput[] = [];
  if (lead.normalizedMobile) or.push({ normalizedMobile: lead.normalizedMobile });
  if (lead.normalizedEmail) or.push({ normalizedEmail: lead.normalizedEmail });
  const siblings = await db.lead.findMany({ where: { id: { not: lead.id }, OR: or }, select: { id: true, firstName: true, normalizedMobile: true, normalizedEmail: true }, orderBy: { createdAt: "desc" }, take: 20 });
  for (const s of siblings) {
    if (!isSameCustomer(lead, s)) continue;
    const found = await fromLead(db, s.id);
    if (found) return { ...found, fromLeadId: s.id };
  }
  return { address: null, source: null, fromLeadId: null };
}
