import type { DbClient } from "@/lib/leadScope.js";
import type { WhatsAppProviderName } from "../../../generated/prisma/client.js";

export type ConversationProviderBasis = "conversation" | "history" | "none";

/** The provider a lead's WhatsApp conversation is on: the conversation row's provider (set from the customer's last
 *  inbound message), else the provider of the lead's latest message (history that predates the conversation model),
 *  else none. Shared by free-text and template sending so both always agree. Never consults the global
 *  WHATSAPP_PROVIDER setting - a lead with history is never re-routed by it. */
export async function findConversationProvider(db: DbClient, leadId: string): Promise<{ provider: WhatsAppProviderName | null; basis: ConversationProviderBasis }> {
  const conversation = await db.whatsAppConversation.findUnique({ where: { leadId }, select: { provider: true } });
  if (conversation) return { provider: conversation.provider, basis: "conversation" };
  const last = await db.whatsAppMessage.findFirst({ where: { leadId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { provider: true } });
  if (last) return { provider: last.provider, basis: "history" };
  return { provider: null, basis: "none" };
}
