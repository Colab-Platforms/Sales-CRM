-- Campaign segments, customer classification and the staged, resumable lead file import. Additive only: new enums/tables, new nullable or defaulted columns, three built-in segments. No existing row is changed.

-- CreateEnum
CREATE TYPE "customer_class" AS ENUM ('REPEAT', 'LOYAL', 'VIP');
CREATE TYPE "import_row_status" AS ENUM ('PENDING', 'CREATED', 'UPDATED', 'DUPLICATE', 'FAILED');

-- AlterEnum
ALTER TYPE "import_batch_status" ADD VALUE 'PROCESSING';

-- AlterTable: leads
ALTER TABLE "leads" ADD COLUMN "order_count" INTEGER,
ADD COLUMN "total_orders_value" DECIMAL(14,2),
ADD COLUMN "last_order_at" TIMESTAMP(3),
ADD COLUMN "customer_class" "customer_class",
ADD COLUMN "import_data" JSONB;
CREATE INDEX "leads_customer_class_idx" ON "leads"("customer_class");

-- AlterTable: lead_import_batches
ALTER TABLE "lead_import_batches" ADD COLUMN "segment_id" UUID,
ADD COLUMN "signature" VARCHAR(64),
ADD COLUMN "processed_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "created_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updated_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failed_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "segment_added" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "finished_at" TIMESTAMP(3),
ADD COLUMN "last_error" VARCHAR(500);

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "color" VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "segments_name_key_key" ON "segments"("name_key");

CREATE TABLE "lead_segments" (
    "lead_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "import_batch_id" UUID,
    "added_by_id" UUID,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_segments_pkey" PRIMARY KEY ("lead_id","segment_id")
);
CREATE INDEX "lead_segments_segment_id_idx" ON "lead_segments"("segment_id");
CREATE INDEX "lead_segments_import_batch_id_idx" ON "lead_segments"("import_batch_id");

CREATE TABLE "lead_import_rows" (
    "id" SERIAL NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "status" "import_row_status" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(255),
    "lead_id" UUID,
    CONSTRAINT "lead_import_rows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_import_rows_batch_id_row_number_key" ON "lead_import_rows"("batch_id","row_number");
CREATE INDEX "lead_import_rows_batch_id_status_idx" ON "lead_import_rows"("batch_id","status");

CREATE TABLE "lead_import_mappings" (
    "id" UUID NOT NULL,
    "signature" VARCHAR(64) NOT NULL,
    "mapping" JSONB NOT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_import_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_import_mappings_signature_key" ON "lead_import_mappings"("signature");

-- AddForeignKey
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lead_segments" ADD CONSTRAINT "lead_segments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_segments" ADD CONSTRAINT "lead_segments_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lead_import_rows" ADD CONSTRAINT "lead_import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "lead_import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The three built-in campaign segments.
INSERT INTO "segments" ("id", "name", "name_key", "color", "is_system", "updated_at") VALUES
  (gen_random_uuid(), 'Repeat Customers', 'repeat customers', '#0ea5e9', true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Loyal Customers', 'loyal customers', '#10b981', true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'VIP Customers', 'vip customers', '#f59e0b', true, CURRENT_TIMESTAMP);
