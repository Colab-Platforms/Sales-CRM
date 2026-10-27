-- Forward-only, additive. Lets an Admin cancel an upcoming report occurrence (a CANCELLED run that owns the occurrence's unique dedupe_key) and hide a finished run from the history (soft delete), each with an audit trail.
-- Adds one enum value and four nullable columns; no row is rewritten. APPLY THIS BEFORE deploying the code that writes them.
ALTER TYPE "report_delivery_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TABLE "report_deliveries" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3);
ALTER TABLE "report_deliveries" ADD COLUMN IF NOT EXISTS "cancelled_by_id" UUID;
ALTER TABLE "report_deliveries" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "report_deliveries" ADD COLUMN IF NOT EXISTS "deleted_by_id" UUID;
