-- Documents an `activity_type` enum value that was already added directly to the
-- database (drift) before this migration existed. IF NOT EXISTS makes this safe
-- to replay on a fresh shadow database too.
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'WHATSAPP_MESSAGE_EDITED';
