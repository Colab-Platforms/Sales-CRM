export type CallStatusFilter = "ALL" | "CONNECTED" | "NOT_CONNECTED" | "FAILED";
export type LeadStatusFilter = "ALL" | "NOT_CONTACTED" | "CONTACTED" | "INTERESTED" | "CONVERTED";
export type PaymentModeFilter = "ALL" | "COD" | "PREPAID";
/** Only sold statuses: cancelled, returned and refunded orders are never part of Sales & Revenue. */
export type OrderStatusFilter = "ALL" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED";

export interface AnalyticsQuery {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  salespersonId?: string;
  callStatus: CallStatusFilter;
  leadStatus: LeadStatusFilter;
  paymentMode: PaymentModeFilter;
  orderStatus: OrderStatusFilter;
  tzOffsetMinutes: number;
}

export interface CallCounts {
  calls: number;
  connected: number;
  notConnected: number;
  failed: number;
  uniqueLeads: number;
  talkTimeSec: number;
}

export interface SalespersonStats extends CallCounts, SalesCounts {
  id: string;
  name: string;
  username: string;
  email: string | null;
  accountStatus: string;
  workStatus: string;
  leads: number;
  contacted: number;
  interested: number;
  converted: number;
  productiveMs: number;
}

/**
 * Eligible orders in rupees. "revenue" is order value net of refunds (booked); "collected" is money actually
 * received (SUCCESS payments net of refunds), so COD shows as collected only once it is marked paid.
 * Orders with no payment method are in the totals but in neither COD nor Prepaid.
 */
export interface SalesCounts {
  orders: number;
  revenue: number;
  /** Of which: Shopify/other orders credited because the telecaller worked that customer in the 7 days before. */
  assistedOrders: number;
  assistedRevenue: number;
  collected: number;
  /** Order value ÷ eligible orders; 0 when there are none. */
  aov: number;
  codOrders: number;
  codRevenue: number;
  codCollected: number;
  prepaidOrders: number;
  prepaidRevenue: number;
  prepaidCollected: number;
}

export interface DailyBucket extends CallCounts, SalesCounts {
  date: string; // YYYY-MM-DD
  productiveMs: number;
  interested: number;
  converted: number;
  bySalesperson: Record<string, CallCounts & SalesCounts & { productiveMs: number; interested: number; converted: number }>;
}

export interface AnalyticsKpis extends SalesCounts {
  totalLeads: number;
  previousTotalLeads: number;
  notContacted: number;
  contacted: number;
  interested: number;
  converted: number;
  callsMade: number;
  connectedCalls: number;
  notConnectedCalls: number;
  failedCalls: number;
  uniqueLeadsContacted: number;
  talkTimeSec: number;
  productiveMs: number;
  previousOrders: number;
  previousRevenue: number;
}

export interface ActivityItem {
  id: string;
  at: string;
  kind: "CALL" | "ACTIVITY" | "SESSION";
  title: string;
  detail: string | null;
  durationSec: number | null;
  leadId: string | null;
}

/** A product's sales in the period (variants rolled up). Revenue is line totals: no shipping or order-level discount. */
export interface ProductSales {
  key: string;
  name: string;
  sku: string | null;
  orders: number;
  units: number;
  revenue: number;
  codOrders: number;
  prepaidOrders: number;
  sellers: number;
  topSalesperson: { id: string; name: string; units: number } | null;
}

export interface ManagerAnalytics {
  range: { from: string; to: string; days: number; tzOffsetMinutes: number };
  targets: { conversionRatePercent: number; productiveMsPerDay: number };
  team: { id: string; name: string; username: string }[];
  kpis: AnalyticsKpis;
  salespeople: SalespersonStats[];
  products: ProductSales[];
  daily: DailyBucket[];
}

export interface SalespersonAnalytics extends ManagerAnalytics {
  salesperson: SalespersonStats;
  recentActivity: ActivityItem[];
}
