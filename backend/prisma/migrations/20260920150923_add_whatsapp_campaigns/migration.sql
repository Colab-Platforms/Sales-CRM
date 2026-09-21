-- CreateEnum
CREATE TYPE "whatsapp_campaign_status" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "whatsapp_campaign_recipient_status" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'SKIPPED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_CAMPAIGN_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_CAMPAIGN_LAUNCHED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_CAMPAIGN_CANCELLED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_CAMPAIGN_COMPLETED';

-- CreateTable
CREATE TABLE "whatsapp_campaigns" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "status" "whatsapp_campaign_status" NOT NULL DEFAULT 'DRAFT',
    "template_id" UUID NOT NULL,
    "filters" JSONB NOT NULL,
    "created_by_id" UUID,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_campaign_recipients" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "order_id" UUID,
    "status" "whatsapp_campaign_recipient_status" NOT NULL DEFAULT 'PENDING',
    "whatsapp_message_id" UUID,
    "failure_reason" TEXT,
    "attempted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_status_idx" ON "whatsapp_campaigns"("status");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_created_by_id_idx" ON "whatsapp_campaigns"("created_by_id");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_scheduled_at_idx" ON "whatsapp_campaigns"("scheduled_at");

-- CreateIndex
CREATE INDEX "whatsapp_campaign_recipients_campaign_id_status_idx" ON "whatsapp_campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "whatsapp_campaign_recipients_lead_id_idx" ON "whatsapp_campaign_recipients"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_campaign_recipients_campaign_id_lead_id_key" ON "whatsapp_campaign_recipients"("campaign_id", "lead_id");

-- AddForeignKey
ALTER TABLE "whatsapp_campaigns" ADD CONSTRAINT "whatsapp_campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaigns" ADD CONSTRAINT "whatsapp_campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "whatsapp_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_whatsapp_message_id_fkey" FOREIGN KEY ("whatsapp_message_id") REFERENCES "whatsapp_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

