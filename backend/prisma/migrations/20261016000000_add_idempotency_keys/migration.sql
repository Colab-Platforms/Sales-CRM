-- Durable idempotency ledger for retried operations (manual order creation). Additive only: one new table, no change to any existing table,
-- so the previous release keeps working against the migrated database and the migration can be rolled forward without downtime.
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "operation" VARCHAR(60) NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "order_id" UUID,
    "status" VARCHAR(30) NOT NULL DEFAULT 'ORDER_CREATED',
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- The uniqueness guarantee that makes concurrent duplicate requests (any process) produce one order.
CREATE UNIQUE INDEX "idempotency_keys_user_id_operation_key_key" ON "idempotency_keys"("user_id", "operation", "key");

CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");
