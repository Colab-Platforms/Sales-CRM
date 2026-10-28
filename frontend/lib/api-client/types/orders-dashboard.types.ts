export type DashboardRangeKind = "yesterday" | "today" | "this_week" | "last_7_days" | "last_30_days" | "this_month" | "last_month" | "custom";
/** How much of the selected period the CRM's data really covers. NONE = nothing is held for it (shown as "no data", never as a zero); PARTIAL = only what has been received so far. */
export type Coverage = "FULL" | "PARTIAL" | "NONE";
export type ChartInterval = "daily" | "weekly" | "monthly";
export interface CardComparison {
  previous: number;
  /** null when the previous period was zero (no baseline). */
  changePct: number | null;
}
/** The tabs inside the order details. (The server also understands ALL, used by the export when no tab is chosen.) */
export type DashboardSection = "WEBSITE" | "TELECALLER";
export type DashboardPaymentFilter = "SUCCESS" | "PENDING" | "PROCESSING" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "NO_PAYMENT";
export type DashboardFulfilmentFilter = "UNFULFILLED" | "FULFILLED" | "CANCELLED" | "RETURNED";
/** One value per summary card; the server applies the same definition to the card's number and to the rows behind it. */
export type DashboardMetric = "TOTAL" | "VALUE" | "COD" | "PREPAID" | "PAID" | "PENDING" | "CANCELLED" | "FULFILLED";

/** The date range is always sent. The rest is only sent once a card has been clicked (no `metric` = cards only, no order rows are read). */
export interface OrdersDashboardQuery {
  range: DashboardRangeKind;
  from?: string;
  to?: string;
  metric?: DashboardMetric;
  /** WEBSITE = the Website Orders dashboard (storefront orders only). */
  scope?: "WEBSITE";
  section?: DashboardSection;
  search?: string;
  paymentStatus?: DashboardPaymentFilter;
  fulfilment?: DashboardFulfilmentFilter;
  page: number;
  pageSize: number;
}

export interface DashboardOrderRow {
  id: string;
  /** What staff recognise: the Shopify number (#1234) when there is one, otherwise the CRM number. */
  orderId: string;
  orderNumber: string;
  orderDate: string;
  customerName: string;
  phone: string | null;
  totalAmount: number;
  currency: string;
  paymentMethod: "COD" | "PREPAID" | null;
  paymentStatus: string | null;
  orderStatus: string;
  fulfilmentStatus: string;
  source: string;
  section: "WEBSITE" | "TELECALLER" | "OTHER";
  telecallerName: string | null;
}

export interface OrdersDashboardSummary {
  totalOrders: number;
  /** Placed value: every order in the date range except cancelled ones. */
  totalValue: number;
  cod: number;
  prepaid: number;
  paid: number;
  pendingPayment: number;
  cancelled: number;
  cancelledValue: number;
  fulfilled: number;
  /** Value of the non-cancelled COD / prepaid orders (same selection as the count cards). */
  codRevenue: number;
  prepaidRevenue: number;
  /** Money received on the selected orders (successful payments, net of partial refunds). */
  collected: number;
}

export interface OrdersDashboardDetails {
  metric: DashboardMetric;
  section: DashboardSection | "ALL";
  /** Orders behind the clicked card, per tab (date range + card only). `other` = API orders, in the card but in neither tab. */
  sections: { website: number; telecaller: number; other: number };
  items: DashboardOrderRow[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export interface ShopifyVerification {
  shopifyCount: number | null;
  crmCount: number;
  verified: boolean;
  perBucket?: boolean;
}
/** Website Orders are read live from Shopify (nothing is imported into the CRM): what was read, when, and anything the viewer must know. */
export interface LiveShopifyInfo {
  source: "SHOPIFY_LIVE";
  fetchedAt: string;
  shopifyOrders: number;
  shopifyCount: number | null;
  websiteOrders: number;
  telecallerExcluded: number;
  pages: number;
  warnings: string[];
}
export interface OrdersDashboardResult {
  range: { kind: DashboardRangeKind; from: string; to: string; timezone: string; days: number };
  coverage: Coverage;
  /** Website scope only: the CRM's count of Shopify orders in the period next to Shopify's own count (null count = Shopify could not be asked). */
  verification: ShopifyVerification | null;
  live?: LiveShopifyInfo;
  /** Versus the period of equal length just before; null unless BOTH periods are fully covered. */
  comparison: { totalOrders: CardComparison | null; totalValue: CardComparison | null } | null;
  /** For the date range only - never changed by a clicked card, tab, search or filter. */
  summary: OrdersDashboardSummary;
  freshness: { latestWebsiteOrderAt: string | null; websiteMayBeIncomplete: boolean; shopifyWebhooksReceived: number; lastShopifyWebhookAt: string | null };
  /** null until a card is clicked. */
  details: OrdersDashboardDetails | null;
}

// ---------------------------------------------------------------------------------------------- Abandoned Checkouts dashboard
export type AbandonedMetric = "TOTAL" | "VALUE" | "PENDING" | "DONE" | "RECOVERED" | "CONVERTED" | "DETECTED" | "COD" | "PREPAID";

export interface AbandonedQuery {
  range: DashboardRangeKind;
  from?: string;
  to?: string;
  metric?: AbandonedMetric;
  search?: string;
  page: number;
  pageSize: number;
}

export interface AbandonedRow {
  id: string;
  checkoutDate: string;
  customerName: string;
  phone: string | null;
  email: string | null;
  amount: number | null;
  currency: string | null;
  itemCount: number | null;
  items: string[];
  checkoutLink: string | null;
  stage: string | null;
  status: string;
  followUp: "PENDING" | "DONE" | "RECOVERED";
  lastAction: { type: string; status: string; at: string } | null;
  assignedTo: string | null;
  /** The order this checkout became (null = not converted). */
  order: null | { orderNumber: string; mode: "COD" | "PREPAID"; status: string; paymentStatus: string | null; amount: number; collected: number; telecaller: string | null };
}

export interface AbandonedConversion {
  converted: number;
  /** Percent (2 dp); null when nothing was detected - not a real 0%. */
  conversionRate: number | null;
  revenue: number;
  prepaid: { count: number; revenue: number };
  cod: { count: number; revenue: number };
  /** Prepaid orders created but not yet verified as paid: not converted, not revenue. */
  awaitingPayment: number;
  /** Linked orders with no recorded payment mode: not counted. */
  unclassified: number;
  byTelecaller: { userId: string | null; name: string | null; converted: number; revenue: number }[];
}

export interface AbandonedSummary {
  totalAbandoned: number;
  /** Cart value of the checkouts that are still open (active or being worked), in INR. */
  potentialValue: number;
  openCheckouts: number;
  followUpPending: number;
  followUpCompleted: number;
  recovered: number;
  /** Every checkout detected in the range (open, converted and recovered), once each. */
  detected: number;
  /** Checkouts that became a real order (COD, or prepaid with a verified payment). Revenue here is ACTUAL order value, never cart value. */
  conversion: AbandonedConversion;
  openWithoutValue: number;
  openOtherCurrency: number;
}

export interface AbandonedResult {
  range: { kind: DashboardRangeKind; from: string; to: string; timezone: string; days: number };
  coverage: Coverage;
  comparison: { totalAbandoned: CardComparison | null } | null;
  summary: AbandonedSummary;
  source: { name: string; paymentModeAvailable: boolean; latestCheckoutAt: string | null };
  details: null | { metric: AbandonedMetric; items: AbandonedRow[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } };
}

// ---------------------------------------------------------------------------------------------- charts
export interface ChartBucketBase {
  /** The bucket's first day (YYYY-MM-DD, business timezone). */
  key: string;
  /** The part of the bucket inside the selected range. */
  from: string;
  to: string;
  /** false = the CRM holds no data for this bucket: its numbers are null and it must not be drawn as zero. */
  available: boolean;
  /** true = the data covers only part of the bucket. */
  partial: boolean;
}
export interface OrdersChartBucket extends ChartBucketBase {
  orders: number | null;
  revenue: number | null;
}
export interface AbandonedChartBucket extends ChartBucketBase {
  abandoned: number | null;
  openValue: number | null;
}
export interface OrdersChartResult {
  range: OrdersDashboardResult["range"];
  interval: ChartInterval;
  coverage: Coverage;
  verification: ShopifyVerification | null;
  live?: LiveShopifyInfo;
  buckets: OrdersChartBucket[];
  totals: { orders: number; revenue: number };
}
export interface AbandonedChartResult {
  range: OrdersDashboardResult["range"];
  interval: ChartInterval;
  coverage: Coverage;
  buckets: AbandonedChartBucket[];
  totals: { abandoned: number; openValue: number };
}

/** Telecaller Performance: the Reports' attribution and money rules (orders a telecaller confirmed in the CRM, or the customer placed within 7 days after a telecaller's call / action). */
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
  assistedOrders: number;
  confirmedOrders: number;
}
export interface TelecallerPerformanceResult {
  range: { kind: string; from: string; to: string; timezone: string; days: number };
  summary: TelecallerSummary;
  /** Orders left out because an amount was missing / invalid - the figures are then incomplete, never silently zero. */
  invalidAmounts: number;
  salespeople: { id: string; name: string }[];
}
export interface TelecallerQuery {
  range?: string;
  from?: string;
  to?: string;
  salespersonId?: string;
  paymentMode?: "ALL" | "COD" | "PREPAID";
  orderStatus?: string;
}
