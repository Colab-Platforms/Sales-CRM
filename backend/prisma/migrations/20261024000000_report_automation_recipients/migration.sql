-- Forward-only. Adds multiple recipients, per-recipient delivery results and a scheduler heartbeat to the report automation.
-- Nothing is dropped or rewritten: the old single `report_automations.recipient` and the old per-run columns of `report_deliveries` stay (the application keeps `recipient` in sync with the first
-- recipient), and the existing data is COPIED into the new tables below. Safe to run once; the data copies are guarded so a re-run adds nothing.

-- CreateEnum
CREATE TYPE "report_recipient_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "report_recipients" (
    "id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "name" VARCHAR(100),
    "phone" VARCHAR(20) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_delivery_recipients" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "name" VARCHAR(100),
    "phone" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(20),
    "status" "report_recipient_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" VARCHAR(255),
    "error" VARCHAR(500),
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_delivery_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_scheduler_state" (
    "id" INTEGER NOT NULL,
    "last_tick_at" TIMESTAMP(3),
    "last_checked" INTEGER NOT NULL DEFAULT 0,
    "last_started" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(300),
    "last_source" VARCHAR(20),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_scheduler_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_recipients_automation_id_phone_key" ON "report_recipients"("automation_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "report_delivery_recipients_delivery_id_phone_key" ON "report_delivery_recipients"("delivery_id", "phone");

-- CreateIndex
CREATE INDEX "report_delivery_recipients_provider_message_id_idx" ON "report_delivery_recipients"("provider_message_id");

-- CreateIndex
CREATE INDEX "report_delivery_recipients_status_next_attempt_at_idx" ON "report_delivery_recipients"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "report_recipients" ADD CONSTRAINT "report_recipients_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "report_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_delivery_recipients" ADD CONSTRAINT "report_delivery_recipients_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "report_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration: the existing single configured number becomes the first recipient (nothing is lost).
INSERT INTO "report_recipients" ("id", "automation_id", "name", "phone", "position", "created_at", "updated_at")
SELECT gen_random_uuid(), a."id", NULL, a."recipient", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "report_automations" a
WHERE a."recipient" IS NOT NULL AND a."recipient" <> ''
  AND NOT EXISTS (SELECT 1 FROM "report_recipients" r WHERE r."automation_id" = a."id" AND r."phone" = a."recipient");

-- DataMigration: every existing delivery keeps its history as one per-recipient result (same status, attempts, provider id, error and times).
INSERT INTO "report_delivery_recipients" ("id", "delivery_id", "name", "phone", "status", "attempts", "provider_message_id", "error", "last_attempt_at", "next_attempt_at", "sent_at", "created_at", "updated_at")
SELECT gen_random_uuid(), d."id", NULL, d."recipient", d."status"::text::"report_recipient_status", d."attempts", d."provider_message_id", d."error",
       CASE WHEN d."attempts" > 0 THEN d."updated_at" ELSE NULL END, d."next_attempt_at", d."sent_at", d."created_at", d."updated_at"
FROM "report_deliveries" d
WHERE NOT EXISTS (SELECT 1 FROM "report_delivery_recipients" x WHERE x."delivery_id" = d."id" AND x."phone" = d."recipient");
