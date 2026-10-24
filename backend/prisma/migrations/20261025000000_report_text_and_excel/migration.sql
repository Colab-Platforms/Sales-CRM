-- Forward-only. Adds the Excel DOCUMENT as a second, separately tracked part of each recipient's delivery, and the text / Excel switches.
-- Existing rows keep their meaning: the existing columns remain the TEXT message; the document part of every existing delivery is SKIPPED (it never had one).
-- Existing automations get sendText = true and sendExcel = true; the Excel is only attempted from the next run on.

-- AlterEnum
ALTER TYPE "report_recipient_status" ADD VALUE IF NOT EXISTS 'SKIPPED';

-- AlterTable
ALTER TABLE "report_automations" ADD COLUMN "send_text" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "send_excel" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "report_delivery_recipients" ADD COLUMN "doc_status" "report_recipient_status" NOT NULL DEFAULT 'SKIPPED',
ADD COLUMN "doc_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "doc_provider_message_id" VARCHAR(255),
ADD COLUMN "doc_media_id" VARCHAR(255),
ADD COLUMN "doc_error" VARCHAR(500),
ADD COLUMN "doc_last_attempt_at" TIMESTAMP(3),
ADD COLUMN "doc_sent_at" TIMESTAMP(3),
ADD COLUMN "doc_delivered_at" TIMESTAMP(3),
ADD COLUMN "doc_read_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "report_delivery_recipients_doc_provider_message_id_idx" ON "report_delivery_recipients"("doc_provider_message_id");
