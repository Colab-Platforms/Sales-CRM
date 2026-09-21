-- CreateEnum
CREATE TYPE "activity_source" AS ENUM ('USER', 'SHOPIFY_SYNC', 'SHOPIFY_WEBHOOK', 'SYSTEM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'ORDER_STATUS_CHANGED';
ALTER TYPE "activity_type" ADD VALUE 'ORDER_CANCELLED';
ALTER TYPE "activity_type" ADD VALUE 'PAYMENT_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'PAYMENT_STATUS_CHANGED';
ALTER TYPE "activity_type" ADD VALUE 'PAYMENT_REFUNDED';
ALTER TYPE "activity_type" ADD VALUE 'PAYMENT_MISMATCH_DETECTED';
ALTER TYPE "activity_type" ADD VALUE 'SHIPMENT_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'SHIPMENT_STATUS_CHANGED';
ALTER TYPE "activity_type" ADD VALUE 'TRACKING_UPDATED';
ALTER TYPE "activity_type" ADD VALUE 'DISCOUNT_CHANGED';

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "actor_role" "role",
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "new_value" JSONB,
ADD COLUMN     "old_value" JSONB,
ADD COLUMN     "order_id" UUID,
ADD COLUMN     "source" "activity_source" NOT NULL DEFAULT 'SYSTEM';

-- CreateIndex
CREATE INDEX "activities_order_id_idx" ON "activities"("order_id");

-- CreateIndex
CREATE INDEX "activities_source_idx" ON "activities"("source");

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

