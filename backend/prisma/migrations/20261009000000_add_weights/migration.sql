-- Weights (kg), all nullable and never back-filled: product/variant weight (informational), the packed parcel weight on the order, and the
-- weight a Shiprocket shipment was created with. Existing rows stay NULL until a person records a real value.
ALTER TABLE "products" ADD COLUMN "weight_kg" DECIMAL(8,3);
ALTER TABLE "product_variants" ADD COLUMN "weight_kg" DECIMAL(8,3);
ALTER TABLE "orders" ADD COLUMN "parcel_weight_kg" DECIMAL(8,3);
ALTER TABLE "shipments" ADD COLUMN "weight_kg" DECIMAL(8,3);
