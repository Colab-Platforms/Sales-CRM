import { leadDetailHref } from "@/components/leads/lead-table";
import { customerDetailHref } from "./orders-table";

export interface CustomerDetailsTarget {
  href: string;
  /** true = the customer's abandoned-lead page; false = the customer profile. */
  abandoned: boolean;
  /** Shown beside the button when the abandoned-lead page could not be used. */
  note: string | null;
}

/**
 * Where "View Customer Details" on an order goes. A telecaller (SALESPERSON) is taken to the abandoned-lead page of THE customer on the order - opened by lead id + abandonment id, never
 * the abandoned-leads list - when the server says they may open one (OrderDetail.customer.abandonmentId is already limited to the customer's own checkouts and the viewer's scope). When
 * there is none, the existing customer profile for the SAME customer opens, with a plain note, instead of any other lead. Other roles keep the customer profile as before.
 */
export function customerDetailsTarget(input: { role: string | undefined; leadId: string; abandonmentId?: string | null }): CustomerDetailsTarget {
  const { role, leadId, abandonmentId } = input;
  if (role !== "SALESPERSON") return { href: customerDetailHref(leadId), abandoned: false, note: null };
  if (abandonmentId) return { href: leadDetailHref(leadId, { from: "abandoned-leads", abandonmentId }), abandoned: true, note: null };
  return { href: customerDetailHref(leadId), abandoned: false, note: "No abandoned lead exists for this customer, so their customer profile opens instead." };
}
