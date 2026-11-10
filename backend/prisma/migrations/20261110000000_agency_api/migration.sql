-- External AI calling agency API: API keys (hash only) and a log of every payment-link request. Additive: two new tables, nothing existing is changed.
CREATE TABLE "agency_api_keys" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "rate_limit_per_minute" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "agency_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agency_message_requests" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(200) NOT NULL,
    "to_masked" VARCHAR(30) NOT NULL,
    "link_host" VARCHAR(255) NOT NULL,
    "order_ref" VARCHAR(100),
    "lead_id" UUID,
    "order_id" UUID,
    "message_id" UUID,
    "provider_message_id" VARCHAR(255),
    "template_name" VARCHAR(255),
    "http_status" INTEGER,
    "error_code" VARCHAR(60),
    "error_message" TEXT,
    "response" JSONB,
    "source_ip" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "agency_message_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agency_api_keys_key_hash_key" ON "agency_api_keys"("key_hash");
CREATE UNIQUE INDEX "agency_message_requests_api_key_id_idempotency_key_key" ON "agency_message_requests"("api_key_id", "idempotency_key");
CREATE INDEX "agency_message_requests_request_hash_created_at_idx" ON "agency_message_requests"("request_hash", "created_at");
CREATE INDEX "agency_message_requests_to_masked_created_at_idx" ON "agency_message_requests"("to_masked", "created_at");
CREATE INDEX "agency_message_requests_created_at_idx" ON "agency_message_requests"("created_at");

ALTER TABLE "agency_message_requests" ADD CONSTRAINT "agency_message_requests_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "agency_api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
