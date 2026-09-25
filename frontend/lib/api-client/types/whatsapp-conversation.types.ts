// Kept in sync with backend/src/modules/whatsapp/whatsapp.conversation.types.ts.
import type { ConversationMode, OrderConversationState } from "./whatsapp-history.types";

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
  provider: "AISENSY" | "GUPSHUP" | "META";
  mode: ConversationMode;
  assignedTo: { id: string; name: string } | null;
  orderState: OrderConversationState;
  orderDraft: OrderDraft | null;
  aiSuggestedReply: string | null;
  lastAiHandoffReason: string | null;
  createdOrderId: string | null;
  unreadCount: number;
}

export interface OrderDraftResult {
  orderState: OrderConversationState;
  orderDraft: OrderDraft | null;
}

export type FreeTextBlockReason = "PROVIDER_NOT_META" | "META_NOT_CONFIGURED" | "SERVICE_WINDOW_CLOSED";

/** Server-decided messaging state for a conversation (GET /whatsapp/conversations/:leadId/capability). */
export interface MessagingCapability {
  activeProvider: "AISENSY" | "GUPSHUP" | "META" | null;
  activeProviderLabel: string | null;
  freeText: { allowed: boolean; reason: FreeTextBlockReason | null; message: string | null };
  serviceWindow: { open: boolean; lastInboundAt: string | null; expiresAt: string | null };
  /** The provider a template send to this customer would go through (or why it can't be sent). */
  templates: { provider: "AISENSY" | "GUPSHUP" | "META" | null; message: string | null };
}
