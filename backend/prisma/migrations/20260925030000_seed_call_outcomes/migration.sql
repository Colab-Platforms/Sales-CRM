-- Seed the fixed set of call outcomes a salesperson picks after a call. Fixed ids (not gen_random_uuid())
-- so this is reproducible across every environment without depending on a Postgres extension.
-- Ids are written as valid v4 UUIDs (version nibble 4, variant nibble 8) - zod's z.string().uuid()
-- (used on every uuid param/body field in this app, including outcomeId) rejects a non-RFC4122
-- shaped id like 0000-0000-0001-... outright, so a made-up id here must still look like a real one.
-- requires_note = true wherever the customer actually spoke (the call was picked up) - a note is
-- mandatory there; a not-connected outcome (busy/switched off/DND/no answer) needs none.

INSERT INTO "call_outcomes" (id, name, code, category, requires_followup, requires_note, is_active, created_at) VALUES
  ('00000000-0000-4000-8001-000000000001', 'Ringing / no answer', 'RINGING_NO_ANSWER',   'NOT_CONNECTED', false, false, true, now()),
  ('00000000-0000-4000-8001-000000000002', 'Busy',                'BUSY',                'NOT_CONNECTED', false, false, true, now()),
  ('00000000-0000-4000-8001-000000000003', 'Switched off',        'SWITCHED_OFF',        'NOT_CONNECTED', false, false, true, now()),
  ('00000000-0000-4000-8001-000000000004', 'Not reachable',       'NOT_REACHABLE',       'NOT_CONNECTED', false, false, true, now()),
  ('00000000-0000-4000-8001-000000000005', 'DND',                 'DND',                 'NOT_CONNECTED', false, false, true, now()),
  ('00000000-0000-4000-8001-000000000006', 'Call back requested', 'CALL_BACK_REQUESTED', 'FOLLOW_UP',     true,  true,  true, now()),
  ('00000000-0000-4000-8001-000000000007', 'Follow up needed',    'FOLLOW_UP_NEEDED',    'FOLLOW_UP',     true,  true,  true, now()),
  ('00000000-0000-4000-8001-000000000008', 'Interested',          'INTERESTED',          'INTERESTED',    false, true,  true, now()),
  ('00000000-0000-4000-8001-000000000009', 'Not interested',      'NOT_INTERESTED',      'NOT_INTERESTED',false, true,  true, now())
ON CONFLICT (code) DO NOTHING;
