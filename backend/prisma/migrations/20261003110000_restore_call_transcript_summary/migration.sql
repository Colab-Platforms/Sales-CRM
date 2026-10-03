-- Restores call_transcripts.summary, dropped by 20261003100000_drop_call_transcript_summary.
ALTER TABLE "call_transcripts" ADD COLUMN "summary" TEXT;
