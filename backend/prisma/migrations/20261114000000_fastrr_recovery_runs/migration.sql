-- Fastrr abandoned-cart recovery: history of confirmed import runs (cart ids and reasons only, no personal data). Additive only - a new table, nothing else is touched.
CREATE TABLE "fastrr_recovery_runs" (
    "id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "from_day" VARCHAR(10) NOT NULL,
    "to_day" VARCHAR(10) NOT NULL,
    "include_converted" BOOLEAN NOT NULL DEFAULT false,
    "retry_of_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "existing" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "converted" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "merged" INTEGER NOT NULL DEFAULT 0,
    "skipped_existing" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fastrr_recovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fastrr_recovery_runs_started_at_idx" ON "fastrr_recovery_runs"("started_at");

-- CreateIndex
CREATE INDEX "fastrr_recovery_runs_status_idx" ON "fastrr_recovery_runs"("status");
