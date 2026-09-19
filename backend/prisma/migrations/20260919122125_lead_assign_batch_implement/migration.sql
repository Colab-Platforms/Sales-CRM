-- CreateEnum
CREATE TYPE "import_batch_status" AS ENUM ('DRAFT', 'COMMITTED', 'FAILED');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "assigned_manager_id" UUID,
ADD COLUMN     "import_batch_id" UUID;

-- CreateTable
CREATE TABLE "lead_import_batches" (
    "id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "status" "import_batch_status" NOT NULL DEFAULT 'DRAFT',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "column_mapping" JSONB NOT NULL,
    "parsed_rows" JSONB,
    "error_rows" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMP(3),

    CONSTRAINT "lead_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_assignment_round_robin" (
    "id" UUID NOT NULL,
    "last_assigned_manager_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manager_assignment_round_robin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_import_batches_uploaded_by_id_idx" ON "lead_import_batches"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "lead_import_batches_status_idx" ON "lead_import_batches"("status");

-- CreateIndex
CREATE INDEX "lead_import_batches_created_at_idx" ON "lead_import_batches"("created_at");

-- CreateIndex
CREATE INDEX "leads_assigned_manager_id_idx" ON "leads"("assigned_manager_id");

-- CreateIndex
CREATE INDEX "leads_import_batch_id_idx" ON "leads"("import_batch_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_manager_id_fkey" FOREIGN KEY ("assigned_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "lead_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_assignment_round_robin" ADD CONSTRAINT "manager_assignment_round_robin_last_assigned_manager_id_fkey" FOREIGN KEY ("last_assigned_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
