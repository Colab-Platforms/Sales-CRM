-- Per-CRM-user state on a shared WhatsAppMessage row ("starred", "deleted for me"). Purely additive,
-- new table only - no existing table/column is changed. See whatsapp.prisma's own comment on
-- WhatsAppMessageUserState for why this is a separate table rather than a column on WhatsAppMessage.

CREATE TABLE "whatsapp_message_user_states" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "hidden_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_user_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_message_user_states_message_id_user_id_key" ON "whatsapp_message_user_states"("message_id", "user_id");

CREATE INDEX "whatsapp_message_user_states_user_id_starred_idx" ON "whatsapp_message_user_states"("user_id", "starred");

CREATE INDEX "whatsapp_message_user_states_user_id_hidden_at_idx" ON "whatsapp_message_user_states"("user_id", "hidden_at");

ALTER TABLE "whatsapp_message_user_states" ADD CONSTRAINT "whatsapp_message_user_states_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "whatsapp_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "whatsapp_message_user_states" ADD CONSTRAINT "whatsapp_message_user_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
