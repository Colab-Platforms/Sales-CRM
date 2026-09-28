-- Adds one enum value so a customer profile can be safely deactivated (WhatsApp Inbox Part 8) without
-- a hard DELETE, which the schema does not support (no cascading FK from Lead). Purely additive.
ALTER TYPE "lead_working_status" ADD VALUE IF NOT EXISTS 'DEACTIVATED';
