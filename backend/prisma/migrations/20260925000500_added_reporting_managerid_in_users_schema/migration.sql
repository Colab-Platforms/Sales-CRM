-- AlterTable
ALTER TABLE "users" ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "reporting_manager_id" UUID;

-- CreateIndex
CREATE INDEX "users_reporting_manager_id_idx" ON "users"("reporting_manager_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_reporting_manager_id_fkey" FOREIGN KEY ("reporting_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
