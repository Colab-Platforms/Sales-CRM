-- CreateEnum
CREATE TYPE "refund_execution_status" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'REFUND_EXECUTION_STARTED';
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'REFUND_COMPLETED';
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'REFUND_EXECUTION_FAILED';


-- AlterTable
ALTER TABLE "refund_requests" ADD COLUMN     "cf_refund_id" VARCHAR(100),
ADD COLUMN     "executed_by_id" UUID,
ADD COLUMN     "executed_by_role" "role",
ADD COLUMN     "execution_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "execution_completed_at" TIMESTAMP(3),
ADD COLUMN     "execution_started_at" TIMESTAMP(3),
ADD COLUMN     "execution_status" "refund_execution_status",
ADD COLUMN     "provider_error_code" VARCHAR(100),
ADD COLUMN     "provider_status" VARCHAR(50),
ADD COLUMN     "refund_id" VARCHAR(40);

-- CreateIndex
CREATE UNIQUE INDEX "refund_requests_refund_id_key" ON "refund_requests"("refund_id");

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_executed_by_id_fkey" FOREIGN KEY ("executed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

