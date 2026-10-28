import { OrderStatus } from "../../../generated/prisma/enums.js";
import { addSale, emptySales, salesOut, SOLD_STATUSES, type PaymentModeFilter, type SoldOrder } from "../manager/manager.sales.js";

// TELECALLER PERFORMANCE (Orders Dashboard). The population and every money figure are the Reports' own: manager.sales.ts soldOrders() decides WHICH orders count (confirmed by a telecaller in the CRM, or placed by
// the same customer within ASSIST_WINDOW_DAYS = 7 days after a telecaller called / worked them; each order credited to ONE telecaller, counted once) and addSale()/salesOut() add them up. Nothing here re-derives that.
//   Total orders / COD / prepaid / revenue / COD revenue / prepaid revenue / collected  = Reports' orders / codOrders / prepaidOrders / revenue / codRevenue / prepaidRevenue / collected.
//   Paid     = orders whose payment is fully or partly (net of refund) received: paymentStatus SUCCESS or PARTIALLY_REFUNDED - the dashboard's "collected" rule.
//   Pending  = every other order in the population (COD not yet collected, payment pending / processing / none recorded). Paid + Pending = Total.
//   Fulfilled = status SHIPPED / OUT_FOR_DELIVERY / DELIVERED.
// These orders are NOT "all website orders": they are the subset a telecaller is credited for, and one can also appear in the Website Orders section (a Shopify order bought after a call) - so the sections must not be added together.

export const PAYMENT_MODES: PaymentModeFilter[] = ["ALL", "COD", "PREPAID"];
export const ORDER_STATUSES = ["ALL", ...SOLD_STATUSES] as const;

const FULFILLED: OrderStatus[] = [OrderStatus.SHIPPED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED];
const PAID = ["SUCCESS", "PARTIALLY_REFUNDED"];

export interface TelecallerSummary {
  totalOrders: number;
  cod: number;
  prepaid: number;
  codRevenue: number;
  prepaidRevenue: number;
  totalRevenue: number;
  paid: number;
  pendingPayment: number;
  collected: number;
  fulfilled: number;
  /** Of the total: credited because the customer bought after the telecaller's call / action (not confirmed in the CRM). */
  assistedOrders: number;
  confirmedOrders: number;
}

/** Pure: the section's cards from the Reports' credited orders. An order with a non-finite amount is never silently counted as 0: it is left out and reported in `invalidAmounts`, so the page can say the figures are incomplete. */
export function summarizeTelecaller(sold: Pick<SoldOrder, "cents" | "collectedCents" | "mode" | "credit" | "status" | "paymentStatus">[]): { summary: TelecallerSummary; invalidAmounts: number } {
  const tally = emptySales();
  let paid = 0;
  let fulfilled = 0;
  let invalid = 0;
  for (const s of sold) {
    if (!Number.isFinite(s.cents) || !Number.isFinite(s.collectedCents)) {
      invalid += 1;
      continue;
    }
    addSale(tally, s);
    if (s.paymentStatus && PAID.includes(s.paymentStatus)) paid += 1;
    if (FULFILLED.includes(s.status)) fulfilled += 1;
  }
  const out = salesOut(tally);
  return {
    invalidAmounts: invalid,
    summary: {
      totalOrders: out.orders,
      cod: out.codOrders,
      prepaid: out.prepaidOrders,
      codRevenue: out.codRevenue,
      prepaidRevenue: out.prepaidRevenue,
      totalRevenue: out.revenue,
      paid,
      pendingPayment: out.orders - paid,
      collected: out.collected,
      fulfilled,
      assistedOrders: out.assistedOrders,
      confirmedOrders: out.orders - out.assistedOrders,
    },
  };
}
