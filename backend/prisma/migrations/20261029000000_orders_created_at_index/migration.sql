-- Forward-only, additive. Every Orders Dashboard request filters orders by a created_at range and sorts by it; without an index that is a scan of the whole orders table.
-- Plain CREATE INDEX on ~28k rows takes well under a second; no data is touched.
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");
