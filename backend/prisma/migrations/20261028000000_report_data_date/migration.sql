-- Forward-only. Adds the selectable report DATA date: a saved calendar date for the "specific date" mode, and the first day of a multi-day run so its history and any retry cover the same period.
-- Existing rows keep behaving exactly as before: report_for stays TODAY / YESTERDAY; both new columns are nullable.
ALTER TABLE "report_automations" ADD COLUMN "report_data_date" VARCHAR(10);
ALTER TABLE "report_deliveries" ADD COLUMN "report_range_start" VARCHAR(10);
