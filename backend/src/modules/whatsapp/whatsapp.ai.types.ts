import { z } from "zod";

// What one AI call extracts from the latest customer message, given the conversation history and
// current order draft as context. Deliberately does NOT include a "create the order" field - order
// creation is a deterministic decision made in whatsapp.order-conversation.service.ts from
// `customerConfirmed` plus an independent keyword check on the raw message, never from this schema
// alone (see that file's header comment for why).
export const OrderExtractionSchema = z.object({
  /** The product the customer appears to be referring to, exactly as named in the catalog snippet given - never invented. Omitted when no product is mentioned this turn. */
  productMention: z.string().optional(),
  variantMention: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  customerName: z.string().optional(),
  phone: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  paymentMethod: z.enum(["COD", "CASH", "CARD", "UPI", "NET_BANKING", "WALLET", "PAYMENT_LINK", "OTHER"]).optional(),
  /** 0-1, the model's own confidence that it understood this message correctly. */
  confidence: z.number().min(0).max(1),
  /** True when the customer explicitly asked for a human agent. */
  customerWantsHuman: z.boolean(),
  /** True when the request is outside order-taking (a complaint, an unrelated question, something the model cannot safely handle here). */
  unsupportedRequest: z.boolean(),
  /** True only when the customer's message is itself an explicit, unambiguous confirmation to place the order (e.g. "yes place it", "confirm"). Never true just because the order looks complete. */
  customerConfirmed: z.boolean(),
  /** The next message to send the customer - a clarifying question, an order summary, or a confirmation. Never mentions internal state, credentials, or anything not meant for the customer. */
  suggestedReply: z.string(),
});

export type OrderExtraction = z.infer<typeof OrderExtractionSchema>;

export interface CatalogSnippetItem {
  id: string;
  name: string;
  variants: { id: string; name: string; price: string | null }[];
  basePrice: string | null;
}
