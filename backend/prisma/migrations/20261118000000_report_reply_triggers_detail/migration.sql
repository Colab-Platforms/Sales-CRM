-- Reply-triggered detailed report switch for the Daily Team Report automation. Additive, defaults ON (the existing behaviour). No data change.
ALTER TABLE "report_automations" ADD COLUMN IF NOT EXISTS "reply_triggers_detail" BOOLEAN NOT NULL DEFAULT true;
