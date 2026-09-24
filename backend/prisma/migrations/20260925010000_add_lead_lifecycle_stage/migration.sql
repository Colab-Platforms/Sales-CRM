-- CreateEnum
CREATE TYPE "lifecycle_stage" AS ENUM ('LEAD', 'CUSTOMER');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "lifecycle_stage" "lifecycle_stage" NOT NULL DEFAULT 'LEAD';

-- Backfill: anyone with an order is a customer.
UPDATE "leads" SET "lifecycle_stage" = 'CUSTOMER'
WHERE EXISTS (SELECT 1 FROM "orders" o WHERE o."lead_id" = "leads"."id");

-- CreateIndex
CREATE INDEX "leads_lifecycle_stage_created_at_idx" ON "leads"("lifecycle_stage", "created_at");
