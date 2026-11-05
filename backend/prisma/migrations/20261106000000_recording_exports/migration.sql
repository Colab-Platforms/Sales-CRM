-- Forward-only, additive: three new tables for background call-recording ZIP exports; nothing existing is changed.
-- APPLY THIS BEFORE deploying the code that uses it (the export endpoints return an error until it is applied).
CREATE TABLE IF NOT EXISTS "recording_export_jobs" (
  "id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "role" VARCHAR(30) NOT NULL,
  "from_day" VARCHAR(10) NOT NULL,
  "to_day" VARCHAR(10) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  "total" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "duplicates" INTEGER NOT NULL DEFAULT 0,
  "data_end" BIGINT NOT NULL DEFAULT 0,
  "size_bytes" BIGINT NOT NULL DEFAULT 0,
  "file_name" VARCHAR(200),
  "error_message" TEXT,
  "heartbeat_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recording_export_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "recording_export_jobs_created_by_id_created_at_idx" ON "recording_export_jobs"("created_by_id", "created_at");
CREATE INDEX IF NOT EXISTS "recording_export_jobs_status_idx" ON "recording_export_jobs"("status");
CREATE INDEX IF NOT EXISTS "recording_export_jobs_expires_at_idx" ON "recording_export_jobs"("expires_at");

CREATE TABLE IF NOT EXISTS "recording_export_items" (
  "job_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "call_id" UUID NOT NULL,
  "file_name" VARCHAR(200) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "reason" VARCHAR(200),
  "crc32" BIGINT,
  "size" BIGINT,
  "local_offset" BIGINT,
  "end_offset" BIGINT,
  CONSTRAINT "recording_export_items_pkey" PRIMARY KEY ("job_id", "seq"),
  CONSTRAINT "recording_export_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "recording_export_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "recording_export_items_job_id_status_idx" ON "recording_export_items"("job_id", "status");

CREATE TABLE IF NOT EXISTS "recording_export_chunks" (
  "job_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  CONSTRAINT "recording_export_chunks_pkey" PRIMARY KEY ("job_id", "seq"),
  CONSTRAINT "recording_export_chunks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "recording_export_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
