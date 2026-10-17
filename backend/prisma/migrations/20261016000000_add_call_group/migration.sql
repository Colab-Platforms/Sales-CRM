-- Adds the raw CallerDesk call-group classification (e.g. "callgroup1") to calls, so inbound
-- Sales vs Partnership (or any other call group) can be persisted and filtered, not just dropped
-- during webhook parsing. Nullable, additive, no backfill needed - historical rows simply have no
-- recorded call group, same as any other optional provider field added after the fact.
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "call_group" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "calls_call_group_idx" ON "calls"("call_group");
