-- Forward-only. Adds the DETAILED TEXT (a free-form WhatsApp text message, separate from the template notification and the Excel file) as its own tracked part of each recipient's delivery.
-- Existing rows keep their meaning: `status` stays the template message; the detailed-text part of every existing delivery is SKIPPED (it never had one).

-- AlterTable
ALTER TABLE "report_delivery_recipients" ADD COLUMN "txt_status" "report_recipient_status" NOT NULL DEFAULT 'SKIPPED',
ADD COLUMN "txt_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "txt_provider_message_id" VARCHAR(255),
ADD COLUMN "txt_error" VARCHAR(500),
ADD COLUMN "txt_last_attempt_at" TIMESTAMP(3),
ADD COLUMN "txt_sent_at" TIMESTAMP(3),
ADD COLUMN "txt_delivered_at" TIMESTAMP(3),
ADD COLUMN "txt_read_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "report_delivery_recipients_txt_provider_message_id_idx" ON "report_delivery_recipients"("txt_provider_message_id");
