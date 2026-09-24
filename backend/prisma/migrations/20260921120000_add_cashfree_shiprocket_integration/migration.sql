-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "shipment_status" ADD VALUE 'CREATED';
ALTER TYPE "shipment_status" ADD VALUE 'AWB_ASSIGNED';
ALTER TYPE "shipment_status" ADD VALUE 'PICKUP_SCHEDULED';
ALTER TYPE "shipment_status" ADD VALUE 'CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'PAYMENT_LINK_CREATED';
ALTER TYPE "activity_type" ADD VALUE 'PAYMENT_LINK_CANCELLED';
ALTER TYPE "activity_type" ADD VALUE 'SHIPMENT_AWB_ASSIGNED';
ALTER TYPE "activity_type" ADD VALUE 'SHIPMENT_PICKUP_SCHEDULED';
ALTER TYPE "activity_type" ADD VALUE 'SHIPMENT_LABEL_GENERATED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_source" ADD VALUE 'CASHFREE_WEBHOOK';
ALTER TYPE "activity_source" ADD VALUE 'SHIPROCKET_WEBHOOK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "external_source" ADD VALUE 'CASHFREE';
ALTER TYPE "external_source" ADD VALUE 'SHIPROCKET';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "payment_expires_at" TIMESTAMP(3),
ADD COLUMN     "payment_url" TEXT;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "channel_order_id" VARCHAR(100),
ADD COLUMN     "courier_company_id" INTEGER,
ADD COLUMN     "label_url" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "pickup_scheduled_at" TIMESTAMP(3),
ADD COLUMN     "provider_order_id" VARCHAR(100),
ADD COLUMN     "provider_status" VARCHAR(150);

-- CreateIndex
CREATE INDEX "shipments_tracking_number_idx" ON "shipments"("tracking_number");

-- CreateIndex
CREATE INDEX "shipments_provider_order_id_idx" ON "shipments"("provider_order_id");

-- CreateIndex
CREATE INDEX "shipments_channel_order_id_idx" ON "shipments"("channel_order_id");

