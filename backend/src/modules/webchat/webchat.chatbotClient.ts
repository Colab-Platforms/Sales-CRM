import { logger } from "@/utils/logger.js";

/**
 * CRM -> chatbot (Aayush-AI-Commerce) server-to-server delivery for agent replies - the Phase 2
 * counterpart to webhooks/website-chat (chatbot -> CRM). Completely separate secret
 * (WEBSITE_CHAT_AGENT_REPLY_SECRET) from both the inbound webhook secret and any CRM JWT; never
 * accept or send a CRM JWT here, and never expose this secret to browser/frontend code.
 *
 * Fail-soft by design: storing the agent's message in the CRM is the source of truth and always
 * succeeds regardless of this call's outcome. A delivery failure (chatbot down, misconfigured,
 * network error) is logged and reported back via the `delivered` flag - it never throws and never
 * blocks the API response, same fail-soft precedent as every other third-party send in this CRM.
 */

export interface AgentReplyPayload {
  externalConversationId: string;
  text: string;
  agentName: string;
}

export interface AgentReplyDelivery {
  deliver(payload: AgentReplyPayload): Promise<boolean>;
}

/** Make attacker/operator-controlled strings safe and bounded for log lines - same convention as
 * webhooks/website-chat/website-chat.service.ts#logToken. */
function logToken(value: string | null | undefined, max = 60): string {
  if (!value) return "none";
  return value.replace(/[^\w.\-|:() ]/g, "?").slice(0, max);
}

export const httpAgentReplyDelivery: AgentReplyDelivery = {
  async deliver(payload) {
    // Read lazily (not at import time) so the server can start, and every other Website Chat
    // feature keep working, even when two-way reply delivery isn't configured yet.
    const baseUrl = process.env.WEBSITE_CHAT_CHATBOT_BASE_URL?.trim();
    const secret = process.env.WEBSITE_CHAT_AGENT_REPLY_SECRET?.trim();
    if (!baseUrl || !secret) {
      logger.warn(
        "Website Chat agent reply: category=NOT_CONFIGURED (WEBSITE_CHAT_CHATBOT_BASE_URL/WEBSITE_CHAT_AGENT_REPLY_SECRET unset) - reply stored in CRM only.",
      );
      return false;
    }

    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/agent-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-reply-secret": secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn(
          `Website Chat agent reply: category=DELIVERY_FAILED conversation=${logToken(payload.externalConversationId)} status=${res.status}`,
        );
        return false;
      }

      return true;
    } catch (err) {
      logger.warn(
        `Website Chat agent reply: category=DELIVERY_ERROR conversation=${logToken(payload.externalConversationId)} reason=${logToken(err instanceof Error ? err.name : "UnknownError", 40)}`,
      );
      return false;
    }
  },
};
