-- CreateEnum
CREATE TYPE "serviceability_status" AS ENUM ('SERVICEABLE', 'NOT_SERVICEABLE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "serviceability_checked_at" TIMESTAMP(3),
ADD COLUMN     "serviceability_status" "serviceability_status";

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");
