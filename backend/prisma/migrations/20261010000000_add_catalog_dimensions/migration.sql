-- Per-unit product dimensions (cm) from the Shiprocket catalog. All nullable, never back-filled or guessed.
ALTER TABLE "products" ADD COLUMN "length_cm" DECIMAL(8,2), ADD COLUMN "width_cm" DECIMAL(8,2), ADD COLUMN "height_cm" DECIMAL(8,2);
ALTER TABLE "product_variants" ADD COLUMN "length_cm" DECIMAL(8,2), ADD COLUMN "width_cm" DECIMAL(8,2), ADD COLUMN "height_cm" DECIMAL(8,2);
