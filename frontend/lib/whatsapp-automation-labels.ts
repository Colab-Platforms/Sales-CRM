import type { WhatsAppAutomationType } from "@/lib/api-client/types/whatsapp-automations.types";

export const AUTOMATION_LABELS: Record<WhatsAppAutomationType, string> = {
  ORDER_CONFIRMED: "Order Confirmed",
  ORDER_SHIPPED: "Order Shipped",
  ORDER_OUT_FOR_DELIVERY: "Out for Delivery",
  ORDER_DELIVERED: "Delivered",
  PAYMENT_PENDING: "Payment Pending",
  FOLLOW_UP_DUE: "Follow-up Due",
};

export const AUTOMATION_DESCRIPTIONS: Record<WhatsAppAutomationType, string> = {
  ORDER_CONFIRMED: "Sent once when an order becomes confirmed.",
  ORDER_SHIPPED: "Sent once when an order becomes shipped.",
  ORDER_OUT_FOR_DELIVERY: "Sent once when an order goes out for delivery.",
  ORDER_DELIVERED: "Sent once when an order is delivered.",
  PAYMENT_PENDING: "A reminder sent at most once a day per order with money still owed.",
  FOLLOW_UP_DUE: "Sent once when an assigned follow-up task becomes due.",
};
