-- Forward-only. Adds the report roster: the ids of the telecallers the daily report covers. The default '[]' means "every active telecaller in the owner's scope", i.e. existing automations behave exactly as before.
ALTER TABLE "report_automations" ADD COLUMN "included_user_ids" JSONB NOT NULL DEFAULT '[]';
