// Customer-facing wording for order WhatsApp messages (free text). One place, so the payment-link and COD messages
// read the same and a wording change never touches the sending logic. Only customer-safe facts go in: name, order
// number, product names, quantities, the amount and the payment URL - never an internal id, a provider id or a secret.
// The URL is passed through untouched (never trimmed, wrapped or re-encoded).

export interface MessageItem {
  name: string;
  variant?: string | null;
  quantity: number;
}

const BRAND = "Ayush Wellness";

/** ₹1,199 for whole amounts, ₹749.50 when there are paise; other currencies keep their code. */
export function formatMoneyForMessage(amount: string | number, currency = "INR"): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${currency} ${amount}`;
  const text = new Intl.NumberFormat("en-IN", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
  return currency === "INR" ? `₹${text}` : `${currency} ${text}`;
}

const itemLabel = (i: MessageItem) => `${i.name}${i.variant ? ` (${i.variant})` : ""} × ${i.quantity}`;

/** One line for a template variable ({{product_summary}}): "Name (Variant) × 2, Other × 1". */
export function summarizeItems(items: MessageItem[]): string {
  return items.map(itemLabel).join(", ");
}

const firstName = (name: string | undefined) => (name ?? "").trim().split(/\s+/)[0] || "there";

export function buildPaymentLinkMessage(input: { customerName?: string; orderNumber: string; items?: MessageItem[]; amount: string; currency: string; paymentUrl: string }): string {
  const lines = [
    "Payment Link for Your Order 💳",
    "",
    `Hi ${firstName(input.customerName)},`,
    "",
    `Your order ${input.orderNumber} has been created successfully.`,
  ];
  if (input.items?.length) lines.push("", "Items:", ...input.items.map((i) => `• ${itemLabel(i)}`));
  lines.push(
    "",
    `Total: ${formatMoneyForMessage(input.amount, input.currency)}`,
    "",
    "Payment: Pending",
    "",
    "Please complete your payment using the secure link below:",
    input.paymentUrl,
    "",
    "Once payment is completed, we'll process your order.",
    "",
    `Thank you for choosing ${BRAND}.`,
  );
  return lines.join("\n");
}

export function buildOrderConfirmationMessage(input: { customerName?: string; orderNumber: string; items?: MessageItem[]; amount: string; currency: string }): string {
  const lines = [
    "Order Confirmed 🎉",
    "",
    `Hi ${firstName(input.customerName)},`,
    "",
    "Your order has been successfully placed.",
    "",
    `Order: ${input.orderNumber}`,
  ];
  if (input.items?.length) lines.push("", "Items:", ...input.items.map((i) => `• ${itemLabel(i)}`));
  lines.push(
    "",
    `Total: ${formatMoneyForMessage(input.amount, input.currency)}`,
    "",
    "Payment: Cash on Delivery",
    "",
    "We'll keep you updated on your order status.",
    "",
    `Thank you for choosing ${BRAND}.`,
  );
  return lines.join("\n");
}
