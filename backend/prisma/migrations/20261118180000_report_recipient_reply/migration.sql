-- When a report recipient replied to the Daily Team Report (live tracking). Additive and nullable; no data change.
ALTER TABLE "report_delivery_recipients" ADD COLUMN IF NOT EXISTS "replied_at" TIMESTAMP(3);
ALTER TABLE "report_delivery_recipients" ADD COLUMN IF NOT EXISTS "reply_message_id" VARCHAR(255);
