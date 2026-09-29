-- Adds an optional structured JSON column to hold a WhatsApp template's header/footer/buttons, which the existing
-- flat `body` string cannot represent. Purely additive: nullable, no default backfill needed (existing templates
-- never had these parts).
ALTER TABLE "whatsapp_templates" ADD COLUMN "components" JSONB;
