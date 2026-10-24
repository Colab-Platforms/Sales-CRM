-- Daily work bucket on leads. Additive only: two nullable columns, existing rows keep working unchanged.
--   bucket_date      IST calendar date the lead was put in its owner's daily bucket (NULL = not in a bucket)
--   bucket_done_at   when the owner first worked the lead that day (NULL = still in the bucket)
ALTER TABLE "leads"
    ADD COLUMN "bucket_date" DATE,
    ADD COLUMN "bucket_done_at" TIMESTAMP(3);

CREATE INDEX "leads_owner_id_bucket_date_idx" ON "leads"("owner_id", "bucket_date");
