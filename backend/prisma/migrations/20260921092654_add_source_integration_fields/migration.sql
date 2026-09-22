-- CreateEnum
CREATE TYPE "source_type" AS ENUM ('MANUAL', 'CSV', 'META', 'SHOPIFY', 'API');

-- AlterTable
ALTER TABLE "sources" ADD COLUMN     "config" JSONB,
ADD COLUMN     "credentials" JSONB,
ADD COLUMN     "external_account_id" VARCHAR(255),
ADD COLUMN     "last_sync_error" TEXT,
ADD COLUMN     "last_sync_status" VARCHAR(50),
ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "type" "source_type" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "source_id" UUID;

-- CreateIndex
CREATE INDEX "sources_type_idx" ON "sources"("type");

-- CreateIndex
CREATE INDEX "sources_external_account_id_idx" ON "sources"("external_account_id");

-- CreateIndex
CREATE INDEX "webhook_events_source_id_idx" ON "webhook_events"("source_id");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
