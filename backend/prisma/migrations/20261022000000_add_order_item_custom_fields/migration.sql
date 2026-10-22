-- Custom (non-catalogue) order items. Additive only: four new columns on order_items, every existing row keeps working unchanged
-- (item_type defaults to 'CATALOG'; the three custom-item attributes are NULL for catalogue items), so the previous release keeps working
-- against the migrated database and this can be rolled forward without downtime.
--   item_type          'CATALOG' (a Shopify/CRM product line, as before) or 'CUSTOM' (a free-form line with no product / variant)
--   is_taxable         custom items only: whether the item is flagged taxable (the CRM adds no tax itself; the flag is sent to Shopify)
--   requires_shipping  custom items only: physical product (true) or service / digital (false)
--   weight_grams       custom physical items only: optional weight, normalised to grams
ALTER TABLE "order_items"
    ADD COLUMN "item_type" VARCHAR(20) NOT NULL DEFAULT 'CATALOG',
    ADD COLUMN "is_taxable" BOOLEAN,
    ADD COLUMN "requires_shipping" BOOLEAN,
    ADD COLUMN "weight_grams" DECIMAL(12,3);
