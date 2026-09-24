import type { ConversationMode, OrderConversationState, WhatsAppProviderName } from "../../../generated/prisma/enums.js";

// A single accumulated line item - deliberately one product per AI-driven draft, not a cart. Matches
// the phase 3 example conversation ("I want Immunity Booster" -> quantity -> confirm) and keeps the
// state machine/idempotency guard simple and reviewable. A human can still build a multi-item order
// manually via the existing create-order-dialog.tsx, which this draft only ever prefills.
export interface OrderDraft {
  productId?: string;
  productName?: string;
  variantId?: string;
  variantName?: string;
  unitPrice?: string;
  quantity?: number;
  customerName?: string;
  phone?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  pincode?: string;
  paymentMethod?: "COD" | "CASH" | "CARD" | "UPI" | "NET_BANKING" | "WALLET" | "PAYMENT_LINK" | "OTHER";
}

export interface ConversationDetail {
  leadId: string;
  provider: WhatsAppProviderName;
  mode: ConversationMode;
  assignedTo: { id: string; name: string } | null;
  orderState: OrderConversationState;
  orderDraft: OrderDraft | null;
  aiSuggestedReply: string | null;
  lastAiHandoffReason: string | null;
  createdOrderId: string | null;
  unreadCount: number;
}

export interface AssignConversationInput {
  userId: string;
}
