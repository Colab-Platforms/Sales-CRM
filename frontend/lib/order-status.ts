import type {
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentMode,
  PaymentStatus,
} from "./api-client/types/orders.types";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: "Draft",
  PENDING_PAYMENT: "Pending payment",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  REFUNDED: "Refunded",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
};

export const ORDER_STATUS_COLORS: Record<OrderStatus, string> = {
  DRAFT: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  PENDING_PAYMENT: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  CONFIRMED: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  PROCESSING: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  CANCELLED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  RETURNED: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  REFUNDED: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  SHIPPED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  OUT_FOR_DELIVERY: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  DELIVERED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

// Listed in the order an order normally moves through them.
export const ORDER_STATUS_ORDER: OrderStatus[] = [
  "DRAFT",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "RETURNED",
  "REFUNDED",
];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  SUCCESS: "Successful",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially refunded",
};

export const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  PENDING: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  PROCESSING: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  SUCCESS: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  FAILED: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  REFUNDED: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  PARTIALLY_REFUNDED: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
};

export const PAYMENT_STATUS_ORDER: PaymentStatus[] = [
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
];

export const NO_PAYMENT_LABEL = "No payment";
export const NO_PAYMENT_COLOR = "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400";

export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  SALESPERSON: "Salesperson",
  WEBSITE: "Website",
  API: "API",
  SHOPIFY: "Shopify",
};

export const ORDER_SOURCE_ORDER: OrderSource[] = ["SALESPERSON", "WEBSITE", "API", "SHOPIFY"];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  UPI: "UPI",
  NET_BANKING: "Net banking",
  WALLET: "Wallet",
  PAYMENT_LINK: "Payment link",
  OTHER: "Other",
  COD: "Cash on delivery",
};

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  COD: "COD",
  PREPAID: "Prepaid",
};

// Amounts arrive as decimal strings; they are only converted for display.
export function formatMoney(amount: string, currency = "INR"): string {
  const value = Number(amount);
  if (Number.isNaN(value)) return amount;
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string | null | undefined): string {
  return iso ? DATE_FORMAT.format(new Date(iso)) : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? DATE_TIME_FORMAT.format(new Date(iso)) : "—";
}
