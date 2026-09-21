-- CreateEnum
CREATE TYPE "whatsapp_template_status" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'DISABLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_TEMPLATE_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_TEMPLATE_UPDATED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_TEMPLATE_STATUS_CHANGED';
ALTER TYPE "activity_type" ADD VALUE 'WHATSAPP_TEMPLATE_SYNCED';

-- AlterTable
ALTER TABLE "activities" ALTER COLUMN "lead_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "provider" "whatsapp_provider_name" NOT NULL,
    "provider_template_id" VARCHAR(255),
    "external_id" VARCHAR(255),
    "category" VARCHAR(50),
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "status" "whatsapp_template_status" NOT NULL DEFAULT 'DRAFT',
    "quality" VARCHAR(50),
    "last_synced_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_templates_status_idx" ON "whatsapp_templates"("status");

-- CreateIndex
CREATE INDEX "whatsapp_templates_category_idx" ON "whatsapp_templates"("category");

-- CreateIndex
CREATE INDEX "whatsapp_templates_language_idx" ON "whatsapp_templates"("language");

-- CreateIndex
CREATE INDEX "whatsapp_templates_provider_idx" ON "whatsapp_templates"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_provider_name_language_key" ON "whatsapp_templates"("provider", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_provider_provider_template_id_key" ON "whatsapp_templates"("provider", "provider_template_id");

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

