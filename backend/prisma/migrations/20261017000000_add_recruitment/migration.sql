-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('NEW', 'ASSIGNED', 'RINGING', 'NOT_REACHABLE', 'CALL_BACK', 'SCREENED', 'SHORTLISTED', 'REJECTED', 'HIRED', 'NOT_INTERESTED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "role" ADD VALUE 'RECRUITER';

-- DropForeignKey
ALTER TABLE "calls" DROP CONSTRAINT "calls_lead_id_fkey";

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "application_id" UUID,
ALTER COLUMN "lead_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "department" VARCHAR(150),
    "location" VARCHAR(150),
    "status" "job_status" NOT NULL DEFAULT 'OPEN',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "mobile" VARCHAR(30) NOT NULL,
    "normalized_mobile" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "resume_url" TEXT,
    "extra" JSONB,
    "status" "application_status" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "recruiter_id" UUID,
    "import_batch_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_assignments" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "recruiter_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_import_batches" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "column_mapping" JSONB NOT NULL,
    "parsed_rows" JSONB NOT NULL,
    "error_rows" JSONB NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "status" "import_batch_status" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "applications_job_id_status_idx" ON "applications"("job_id", "status");

-- CreateIndex
CREATE INDEX "applications_recruiter_id_status_idx" ON "applications"("recruiter_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "applications_job_id_normalized_mobile_key" ON "applications"("job_id", "normalized_mobile");

-- CreateIndex
CREATE INDEX "application_assignments_application_id_is_current_idx" ON "application_assignments"("application_id", "is_current");

-- CreateIndex
CREATE INDEX "application_assignments_recruiter_id_idx" ON "application_assignments"("recruiter_id");

-- CreateIndex
CREATE INDEX "application_import_batches_job_id_idx" ON "application_import_batches"("job_id");

-- CreateIndex
CREATE INDEX "calls_application_id_idx" ON "calls"("application_id");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_recruiter_id_fkey" FOREIGN KEY ("recruiter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "application_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_recruiter_id_fkey" FOREIGN KEY ("recruiter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_import_batches" ADD CONSTRAINT "application_import_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_import_batches" ADD CONSTRAINT "application_import_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

