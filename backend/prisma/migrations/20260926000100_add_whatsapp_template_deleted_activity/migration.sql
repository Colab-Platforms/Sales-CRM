-- Adds the ActivityType value used to audit a WhatsApp template deletion (local CRM record only - see
-- whatsapp.template.service.ts's deleteTemplate). Enum additions run outside the migration's own implicit
-- transaction in Postgres, same as every other enum-value migration in this project.
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'WHATSAPP_TEMPLATE_DELETED';
