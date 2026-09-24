-- CreateEnum
CREATE TYPE "whatsapp_automation_type" AS ENUM ('ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'PAYMENT_PENDING', 'FOLLOW_UP_DUE');

-- CreateEnum
CREATE TYPE "whatsapp_automation_run_status" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "whatsapp_automation_configs" (
    "id" UUID NOT NULL,
    "automation_type" "whatsapp_automation_type" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "template_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_automation_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_automation_runs" (
    "id" UUID NOT NULL,
    "automation_type" "whatsapp_automation_type" NOT NULL,
    "event_key" TEXT NOT NULL,
    "lead_id" UUID,
    "order_id" UUID,
    "status" "whatsapp_automation_run_status" NOT NULL,
    "whatsapp_message_id" UUID,
    "reason" TEXT,
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_automation_configs_automation_type_key" ON "whatsapp_automation_configs"("automation_type");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_automation_runs_event_key_key" ON "whatsapp_automation_runs"("event_key");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_automation_type_idx" ON "whatsapp_automation_runs"("automation_type");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_lead_id_idx" ON "whatsapp_automation_runs"("lead_id");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_order_id_idx" ON "whatsapp_automation_runs"("order_id");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_status_idx" ON "whatsapp_automation_runs"("status");

-- AddForeignKey
ALTER TABLE "whatsapp_automation_configs" ADD CONSTRAINT "whatsapp_automation_configs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_configs" ADD CONSTRAINT "whatsapp_automation_configs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_runs" ADD CONSTRAINT "whatsapp_automation_runs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_runs" ADD CONSTRAINT "whatsapp_automation_runs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_runs" ADD CONSTRAINT "whatsapp_automation_runs_whatsapp_message_id_fkey" FOREIGN KEY ("whatsapp_message_id") REFERENCES "whatsapp_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

