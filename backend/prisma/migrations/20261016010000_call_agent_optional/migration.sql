-- Inbound IVR calls nobody in the CRM answered (unanswered / answered on a non-CRM phone) must still
-- be stored, so calls.agent_id becomes nullable. Existing rows are unaffected.
ALTER TABLE "calls" ALTER COLUMN "agent_id" DROP NOT NULL;
