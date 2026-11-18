-- Per-recipient enable/disable for the Daily Team Report. Additive; every existing recipient stays enabled. No data change.
ALTER TABLE "report_recipients" ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;
