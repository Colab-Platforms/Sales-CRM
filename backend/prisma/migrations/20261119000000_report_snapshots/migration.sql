-- Immutable per-run snapshot of the figures the initial Daily Team Report message carried. Additive: one new table, no change to existing data.
CREATE TABLE "report_snapshots" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "report_date" VARCHAR(10) NOT NULL,
    "report_range_start" VARCHAR(10),
    "timezone" VARCHAR(64) NOT NULL,
    "template_name" VARCHAR(150),
    "generated_at" TIMESTAMP(3) NOT NULL,
    "values" JSONB NOT NULL,
    "figures" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_snapshots_delivery_id_key" ON "report_snapshots"("delivery_id");
CREATE INDEX "report_snapshots_report_date_idx" ON "report_snapshots"("report_date");
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "report_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- History must never change: any UPDATE of a snapshot is refused (deleting a whole run still cascades).
CREATE OR REPLACE FUNCTION report_snapshots_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'report_snapshots rows are immutable (snapshot %)', OLD.id;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER report_snapshots_no_update BEFORE UPDATE ON report_snapshots FOR EACH ROW EXECUTE FUNCTION report_snapshots_immutable();
