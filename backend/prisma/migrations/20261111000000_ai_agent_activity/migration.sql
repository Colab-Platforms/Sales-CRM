-- AI calling agency activity: a distinct source and type so an AI Agent request is never mistaken for a human telecaller action. Additive only.
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'AI_AGENT_PAYMENT_LINK_REQUEST';
ALTER TYPE "activity_source" ADD VALUE IF NOT EXISTS 'AI_AGENT';
