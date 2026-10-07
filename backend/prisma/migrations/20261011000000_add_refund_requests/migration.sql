-- CreateEnum
CREATE TYPE "refund_request_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'REFUND_REQUESTED';
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'REFUND_APPROVED';
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'REFUND_REJECTED';

-- CreateTable
CREATE TABLE "refund_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_by_role" "role" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'INR',
    "reason" TEXT NOT NULL,
    "status" "refund_request_status" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_by_role" "role",
    "decision_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "failure_reason" TEXT,
    "submission_key" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_requests_order_id_idx" ON "refund_requests"("order_id");

-- CreateIndex
CREATE INDEX "refund_requests_payment_id_idx" ON "refund_requests"("payment_id");

-- CreateIndex
CREATE INDEX "refund_requests_status_idx" ON "refund_requests"("status");

-- CreateIndex
CREATE INDEX "refund_requests_requested_by_id_idx" ON "refund_requests"("requested_by_id");

-- CreateIndex
CREATE INDEX "refund_requests_decided_by_id_idx" ON "refund_requests"("decided_by_id");

-- CreateIndex
CREATE INDEX "refund_requests_created_at_idx" ON "refund_requests"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refund_requests_requested_by_id_submission_key_key" ON "refund_requests"("requested_by_id", "submission_key");

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

