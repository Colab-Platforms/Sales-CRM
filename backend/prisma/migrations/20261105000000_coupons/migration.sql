-- Forward-only, additive: two enums, one new table, three new nullable / defaulted columns. Existing rows are unchanged
-- (every customer is REGULAR until an Admin / Manager marks them DISTRIBUTOR; no order references a coupon).
-- APPLY THIS BEFORE deploying the code that reads it.
DO $$ BEGIN CREATE TYPE "customer_type" AS ENUM ('REGULAR', 'DISTRIBUTOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "coupon_discount_type" AS ENUM ('FIXED', 'PERCENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "customer_type" "customer_type" NOT NULL DEFAULT 'REGULAR';

CREATE TABLE IF NOT EXISTS "coupons" (
  "id" UUID NOT NULL,
  "code" VARCHAR(50) NOT NULL,
  "discount_type" "coupon_discount_type" NOT NULL,
  "discount_value" DECIMAL(12,2) NOT NULL,
  "eligible_customer_type" "customer_type",
  "min_order_value" DECIMAL(12,2),
  "max_discount" DECIMAL(12,2),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "deleted_at" TIMESTAMP(3),
  "created_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "coupons_is_active_deleted_at_idx" ON "coupons"("is_active", "deleted_at");
-- A code is unique among coupons that are not deleted, so a deleted code can be created again.
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_live_key" ON "coupons"("code") WHERE "deleted_at" IS NULL;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coupon_id" UUID;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coupon_code" VARCHAR(50);
CREATE INDEX IF NOT EXISTS "orders_coupon_id_idx" ON "orders"("coupon_id");
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The default distributor coupon: Rs 500 off, distributor customers only, unlimited use. Inserted once; an Admin can edit or switch it off afterwards and a re-run never overwrites that.
INSERT INTO "coupons" ("id", "code", "discount_type", "discount_value", "eligible_customer_type", "is_active", "updated_at")
SELECT gen_random_uuid(), 'DISTRIBUTOR500', 'FIXED', 500.00, 'DISTRIBUTOR', true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "coupons" WHERE "code" = 'DISTRIBUTOR500');
