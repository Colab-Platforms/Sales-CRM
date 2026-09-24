-- Replace WORKING / EXPIRED / CLOSED with call-outcome statuses.
-- Leads:     WORKING -> FOLLOW_UP, EXPIRED and CLOSED -> NOT_INTERESTED.
-- Customers (lifecycle_stage = CUSTOMER, not leads): any removed status -> CONVERTED.
-- NEW, ASSIGNED, INTERESTED, CONVERTED are unchanged.

-- CreateEnum
CREATE TYPE "lead_working_status_new" AS ENUM ('NEW', 'ASSIGNED', 'RINGING', 'BUSY', 'CALL_BACK', 'FOLLOW_UP', 'SWITCHED_OFF', 'DND', 'NOT_REACHABLE', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED');

-- AlterTable
ALTER TABLE "leads" ALTER COLUMN "working_status" DROP DEFAULT;
ALTER TABLE "leads" ALTER COLUMN "working_status" TYPE "lead_working_status_new" USING (
  CASE
    WHEN "working_status"::text IN ('WORKING', 'EXPIRED', 'CLOSED') AND "lifecycle_stage" = 'CUSTOMER' THEN 'CONVERTED'
    WHEN "working_status"::text = 'WORKING' THEN 'FOLLOW_UP'
    WHEN "working_status"::text IN ('EXPIRED', 'CLOSED') THEN 'NOT_INTERESTED'
    ELSE "working_status"::text
  END::"lead_working_status_new"
);
ALTER TABLE "leads" ALTER COLUMN "working_status" SET DEFAULT 'NEW';

-- DropEnum
DROP TYPE "lead_working_status";
ALTER TYPE "lead_working_status_new" RENAME TO "lead_working_status";
