-- E6 Shopify integration: additive only (new nullable columns, enum values and indexes).
-- CreateEnum
CREATE TYPE "external_source" AS ENUM ('SHOPIFY');

-- AlterEnum
ALTER TYPE "order_source" ADD VALUE 'SHOPIFY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "order_status" ADD VALUE 'SHIPPED';
ALTER TYPE "order_status" ADD VALUE 'OUT_FOR_DELIVERY';
ALTER TYPE "order_status" ADD VALUE 'DELIVERED';

-- AlterEnum
ALTER TYPE "payment_method" ADD VALUE 'COD';

-- AlterEnum
ALTER TYPE "webhook_status" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "external_id" VARCHAR(100),
ADD COLUMN     "external_source" "external_source",
ADD COLUMN     "external_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "external_id" VARCHAR(100),
ADD COLUMN     "external_number" VARCHAR(100),
ADD COLUMN     "external_source" "external_source",
ADD COLUMN     "external_updated_at" TIMESTAMP(3),
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "shipping_address" JSONB,
ADD COLUMN     "shipping_pincode" VARCHAR(12);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "external_id" VARCHAR(100),
ADD COLUMN     "external_source" "external_source",
ADD COLUMN     "refunded_amount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "external_id" VARCHAR(100),
ADD COLUMN     "external_source" "external_source",
ADD COLUMN     "external_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "external_id" VARCHAR(100),
ADD COLUMN     "external_source" "external_source",
ADD COLUMN     "external_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "leads_external_source_external_id_key" ON "leads"("external_source", "external_id");

-- CreateIndex
CREATE INDEX "orders_shipping_pincode_idx" ON "orders"("shipping_pincode");

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_source_external_id_key" ON "orders"("external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_external_source_external_id_key" ON "payments"("external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_external_source_external_id_key" ON "product_variants"("external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_external_source_external_id_key" ON "products"("external_source", "external_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_next_attempt_at_idx" ON "webhook_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_external_event_id_key" ON "webhook_events"("provider", "external_event_id");
