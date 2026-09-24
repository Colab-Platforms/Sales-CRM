-- CreateEnum
CREATE TYPE "whatsapp_provider_name" AS ENUM ('AISENSY', 'GUPSHUP');

-- CreateEnum
CREATE TYPE "whatsapp_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "whatsapp_message_type" AS ENUM ('TEXT', 'TEMPLATE', 'MEDIA', 'INTERACTIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "whatsapp_message_status" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_MESSAGE_SENT';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_MESSAGE_RECEIVED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_DELIVERED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_READ';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_FAILED';

-- AlterEnum
ALTER TYPE "activity_source" ADD VALUE 'WHATSAPP_WEBHOOK';

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "provider" "whatsapp_provider_name" NOT NULL,
    "provider_message_id" VARCHAR(255),
    "direction" "whatsapp_direction" NOT NULL,
    "message_type" "whatsapp_message_type" NOT NULL DEFAULT 'TEXT',
    "status" "whatsapp_message_status" NOT NULL,
    "lead_id" UUID,
    "from_number" VARCHAR(32),
    "to_number" VARCHAR(32),
    "normalized_contact" VARCHAR(20),
    "template_name" VARCHAR(150),
    "body" TEXT,
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "sent_by_id" UUID,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_messages_lead_id_idx" ON "whatsapp_messages"("lead_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_direction_idx" ON "whatsapp_messages"("direction");

-- CreateIndex
CREATE INDEX "whatsapp_messages_status_idx" ON "whatsapp_messages"("status");

-- CreateIndex
CREATE INDEX "whatsapp_messages_normalized_contact_idx" ON "whatsapp_messages"("normalized_contact");

-- CreateIndex
CREATE INDEX "whatsapp_messages_created_at_idx" ON "whatsapp_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_provider_message_id_key" ON "whatsapp_messages"("provider", "provider_message_id");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

