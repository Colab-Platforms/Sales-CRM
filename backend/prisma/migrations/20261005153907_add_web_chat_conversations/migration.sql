-- CreateEnum
CREATE TYPE "web_chat_sender" AS ENUM ('CUSTOMER', 'AI', 'AGENT');

-- CreateTable
CREATE TABLE "web_chat_conversations" (
    "id" UUID NOT NULL,
    "external_conversation_id" VARCHAR(100) NOT NULL,
    "lead_id" UUID,
    "mode" "conversation_mode" NOT NULL DEFAULT 'AI',
    "assigned_to_id" UUID,
    "last_read_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "intent" VARCHAR(255),
    "product_interest" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "external_message_id" VARCHAR(100),
    "sender" "web_chat_sender" NOT NULL,
    "sent_by_id" UUID,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_chat_conversations_external_conversation_id_key" ON "web_chat_conversations"("external_conversation_id");

-- CreateIndex
CREATE INDEX "web_chat_conversations_lead_id_idx" ON "web_chat_conversations"("lead_id");

-- CreateIndex
CREATE INDEX "web_chat_conversations_assigned_to_id_idx" ON "web_chat_conversations"("assigned_to_id");

-- CreateIndex
CREATE INDEX "web_chat_conversations_mode_idx" ON "web_chat_conversations"("mode");

-- CreateIndex
CREATE INDEX "web_chat_conversations_last_message_at_idx" ON "web_chat_conversations"("last_message_at");

-- CreateIndex
CREATE INDEX "web_chat_messages_conversation_id_idx" ON "web_chat_messages"("conversation_id");

-- CreateIndex
CREATE INDEX "web_chat_messages_created_at_idx" ON "web_chat_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "web_chat_messages_conversation_id_external_message_id_key" ON "web_chat_messages"("conversation_id", "external_message_id");

-- AddForeignKey
ALTER TABLE "web_chat_conversations" ADD CONSTRAINT "web_chat_conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_chat_conversations" ADD CONSTRAINT "web_chat_conversations_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_chat_messages" ADD CONSTRAINT "web_chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "web_chat_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_chat_messages" ADD CONSTRAINT "web_chat_messages_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
