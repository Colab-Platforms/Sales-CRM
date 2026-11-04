-- Forward-only, additive: one new table, nothing existing is changed. No row is inserted, so every setting keeps its code default
-- (Shopify sync for CRM-created orders = OFF) until an Admin changes it. Re-running never overwrites a saved value.
-- APPLY THIS BEFORE deploying the code that reads it.
CREATE TABLE IF NOT EXISTS "app_setting" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updated_by_id" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);
