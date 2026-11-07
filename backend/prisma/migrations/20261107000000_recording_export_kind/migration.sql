-- Forward-only, additive: lets the same export jobs carry an Excel export of abandoned-lead records as well as the recording ZIP.
-- Existing rows become kind = 'ZIP' (what they all are). No data is rewritten.
ALTER TABLE "recording_export_jobs" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(10) NOT NULL DEFAULT 'ZIP';
ALTER TABLE "recording_export_jobs" ADD COLUMN IF NOT EXISTS "filters" JSONB;
CREATE INDEX IF NOT EXISTS "recording_export_jobs_created_by_id_kind_status_idx" ON "recording_export_jobs"("created_by_id", "kind", "status");
