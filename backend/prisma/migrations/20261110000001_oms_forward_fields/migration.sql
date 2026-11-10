-- OMS webhook forwarding: independent forward-state tracking on webhook_events, separate from that
-- table's own `status`/`attempts`/`error_message` columns (Sales CRM's own processing). Additive
-- only -- one new enum, five new nullable-or-defaulted columns, nothing existing changed or dropped.
-- NOT APPLIED to any database by this change -- see the accompanying report for why (DATABASE_URL in
-- this environment points at a remote Neon instance, not a local dev database).

CREATE TYPE "oms_forward_status" AS ENUM ('PENDING', 'FORWARDING', 'FORWARDED', 'FAILED');

ALTER TABLE "webhook_events"
  ADD COLUMN "oms_forward_status" "oms_forward_status" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "oms_forward_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "oms_forward_next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "oms_forward_error_message" TEXT,
  ADD COLUMN "oms_forwarded_at" TIMESTAMP(3);

CREATE INDEX "webhook_events_oms_forward_status_oms_forward_next_attempt_idx"
  ON "webhook_events" ("oms_forward_status", "oms_forward_next_attempt_at");
