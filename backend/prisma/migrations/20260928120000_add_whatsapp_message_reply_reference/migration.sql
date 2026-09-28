-- Persists Meta's real inbound-message reply reference (context.id) when the customer actually
-- replied to a specific message in WhatsApp. Purely additive, nullable - never backfilled/guessed.
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "reply_to_provider_message_id" VARCHAR(255);
