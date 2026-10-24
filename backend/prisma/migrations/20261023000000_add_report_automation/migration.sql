-- CreateEnum
CREATE TYPE "report_delivery_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "report_delivery_kind" AS ENUM ('SCHEDULED', 'TEST');

-- CreateTable
CREATE TABLE "report_automations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "recipient" VARCHAR(20),
    "send_time" VARCHAR(5) NOT NULL DEFAULT '21:00',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "report_for" VARCHAR(10) NOT NULL DEFAULT 'TODAY',
    "template_name" VARCHAR(150),
    "language_code" VARCHAR(20) NOT NULL DEFAULT 'en',
    "options" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "kind" "report_delivery_kind" NOT NULL,
    "report_date" VARCHAR(10) NOT NULL,
    "dedupe_key" VARCHAR(120),
    "recipient" VARCHAR(20) NOT NULL,
    "status" "report_delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" VARCHAR(255),
    "error" VARCHAR(500),
    "scheduled_for" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_automations_owner_id_key" ON "report_automations"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_deliveries_dedupe_key_key" ON "report_deliveries"("dedupe_key");

-- CreateIndex
CREATE INDEX "report_deliveries_automation_id_created_at_idx" ON "report_deliveries"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "report_deliveries_status_next_attempt_at_idx" ON "report_deliveries"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "report_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
