-- Forward-only, additive. A detailed report / Excel held back because the recipient's 24-hour WhatsApp window is closed is no longer a terminal "Failed": it WAITS for the recipient's reply.
-- Adds one value to the part-status enum; no row is rewritten. APPLY THIS BEFORE deploying the code that writes it (the application would otherwise be refused by the database).
ALTER TYPE "report_recipient_status" ADD VALUE IF NOT EXISTS 'WAITING_FOR_REPLY';
