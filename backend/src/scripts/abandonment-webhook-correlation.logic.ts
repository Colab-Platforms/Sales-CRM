// Pure logic for abandonment-webhook-correlation.ts (no I/O). It correlates stored Shiprocket "Abandon Cart" webhook events with abandonment records
// and states what the stored evidence does and does not support.
//
// How events and records can be linked (schema facts):
//  - WebhookEvent has NO foreign key to Abandonment (only an optional Source). Activity.referenceId points at the abandonment, not at the event.
//  - WebhookEvent.externalEventId is "sha256:<hash of the raw body>" - a delivery/idempotency id. Byte-identical repeats are dropped at record time, so they never appear here.
//  - So the link is: the cart reference the processor stored on the record (Abandonment.referenceId, picked from cart_id / checkout_id / session_id / id / cart_token / token)
//    versus the same pick made on each event's payload. Both are compared ONLY as short SHA-256 fingerprints computed inside the database; raw values never leave it.
//  - Events are tied to the lead by comparing the payload's phone/email with the lead's normalized phone/email INSIDE the database; no contact detail is selected.

// ---- SQL (SELECT-only, parameterised) -------------------------------------------------------------------------------------------------
export const REF_KEYS = ["cart_id", "checkout_id", "session_id", "id", "cart_token", "token"] as const;
export type RefKey = (typeof REF_KEYS)[number];

const STAGE_KEYS = ["latest_stage", "stage", "status", "checkout_stage", "cart_status"] as const;
const PHONE_KEYS = ["phone_number", "phone", "mobile", "contact_number", "customer_phone"] as const;
const EMAIL_KEYS = ["email", "customer_email"] as const;
const NESTED = ["customer", "buyer", "user", "contact"] as const;

// text value of a string/number payload field, trimmed, empty -> null (what the mapper's asString yields)
export const val = (key: string) => `(case when jsonb_typeof(w.payload -> '${key}') in ('string', 'number') then nullif(btrim(w.payload ->> '${key}'), '') end)`;
const nestedVal = (obj: string, key: string) => `(case when jsonb_typeof(w.payload -> '${obj}' -> '${key}') in ('string', 'number') then nullif(btrim(w.payload -> '${obj}' ->> '${key}'), '') end)`;
const present = (key: string) => `(w.payload ? '${key}' and jsonb_typeof(w.payload -> '${key}') <> 'null')`;
const fp = (expr: string) => `left(encode(sha256(convert_to(${expr}, 'UTF8')), 'hex'), 8)`;

// pick(): the FIRST key that is present (not null), even if it then reads as empty - exactly the mapper's rule.
const refKeyExpr = `(case ${REF_KEYS.map((k) => `when ${present(k)} then '${k}'`).join(" ")} end)`;
const refValueExpr = `(case ${REF_KEYS.map((k) => `when ${present(k)} then ${val(k)}`).join(" ")} end)`;
const stageExpr = `(case ${STAGE_KEYS.map((k) => `when ${present(k)} then ${val(k)}`).join(" ")} end)`;

export const phoneExpr = `coalesce(${[...PHONE_KEYS.map(val), ...NESTED.flatMap((o) => ["phone", "mobile"].map((k) => nestedVal(o, k)))].join(", ")})`;
export const emailExpr = `coalesce(${[...EMAIL_KEYS.map(val), ...NESTED.map((o) => nestedVal(o, "email"))].join(", ")})`;
export const digits = (expr: string) => `right(regexp_replace(${expr}, '\\D', '', 'g'), 10)`;

/** $1 = lead number. $2 = uuid[] of the abandonment record ids. Returns the records (ref fingerprint only). */
export const RECORDS_SQL = `select a.id, l.lead_number, a.status, a.reference_type,
    a.cart_snapshot ->> 'stage' as stage,
    case when a.reference_id is null then null else ${fp("a.reference_id")} end as ref_fp,
    a.detected_at, a.created_at, a.updated_at
  from abandonments a join leads l on l.id = a.lead_id
  where l.lead_number = $1 and a.id = any($2::uuid[])
  order by a.created_at asc, a.id asc`;

/** $2 = uuid[] of record ids. Only the system-written title/source/time of each activity - never its description (it holds the resume link). */
export const ACTIVITIES_SQL = `select ac.id, ac.reference_id as abandonment_id, ac.created_at, ac.title, ac.source
  from activities ac join abandonments a on a.id::text = ac.reference_id
  join leads l on l.id = a.lead_id
  where l.lead_number = $1 and ac.reference_type = 'Abandonment' and a.id = any($2::uuid[])
  order by ac.created_at asc, ac.id asc`;

/** $1 lead number, $2 uuid[] record ids, $3 window hours either side of the records' creation times, $4 row cap. */
export const EVENTS_SQL = `with lead as (select normalized_mobile, normalized_email from leads where lead_number = $1),
  bounds as (select min(created_at) as lo, max(created_at) as hi from abandonments where id = any($2::uuid[]))
  select w.id, left(w.external_event_id, 15) as delivery_id, w.event_type, w.status, w.attempts,
    w.received_at, w.processed_at, w.next_attempt_at, (w.error_message is not null) as has_error,
    ${refKeyExpr} as ref_key,
    case when ${refValueExpr} is null then null else ${fp(refValueExpr)} end as ref_fp,
    ${stageExpr} as stage,
    ${val("updated_at")} as payload_updated_at,
    ${val("total_price")} as cart_value,
    case when jsonb_typeof(w.payload -> 'items') = 'array' then jsonb_array_length(w.payload -> 'items') end as item_count,
    case when jsonb_typeof(w.payload -> 'items') = 'array'
      then left(encode(sha256(convert_to((select coalesce(string_agg(coalesce(i ->> 'name', i ->> 'title', '') || 'x' || coalesce(i ->> 'quantity', ''), '|' order by coalesce(i ->> 'name', i ->> 'title', '')), '') from jsonb_array_elements(w.payload -> 'items') i), 'UTF8')), 'hex'), 8) end as items_fp,
    ${REF_KEYS.map((k) => `case when ${val(k)} is null then null else ${fp(val(k))} end as fp_${k}`).join(",\n    ")},
    (l.normalized_mobile is not null and length(${digits("l.normalized_mobile")}) = 10 and ${digits(phoneExpr)} = ${digits("l.normalized_mobile")}) as phone_match,
    (l.normalized_email is not null and lower(${emailExpr}) = l.normalized_email) as email_match
  from webhook_events w cross join lead l cross join bounds b
  where w.provider = 'SHIPROCKET_CHECKOUT' and w.event_type = 'checkout.abandoned'
    and w.received_at between b.lo - make_interval(hours => $3) and b.hi + make_interval(hours => $3)
    and ((l.normalized_mobile is not null and length(${digits("l.normalized_mobile")}) = 10 and ${digits(phoneExpr)} = ${digits("l.normalized_mobile")})
      or (l.normalized_email is not null and lower(${emailExpr}) = l.normalized_email))
  order by w.received_at asc, w.id asc
  limit $4`;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validateRecordIds = (ids: string[]): string[] | null => (ids.length > 0 && ids.length <= 10 && ids.every((i) => UUID_RE.test(i)) ? ids.map((i) => i.toLowerCase()) : null);

// ---- Rows -----------------------------------------------------------------------------------------------------------------------------
export interface RecordRow { id: string; lead_number: string; status: string; reference_type: string | null; stage: string | null; ref_fp: string | null; detected_at: Date; created_at: Date; updated_at: Date }
export interface ActivityRow { id: string; abandonment_id: string; created_at: Date; title: string | null; source: string }
export interface EventRow {
  id: string; delivery_id: string | null; event_type: string; status: string; attempts: number;
  received_at: Date; processed_at: Date | null; next_attempt_at: Date | null; has_error: boolean;
  ref_key: RefKey | null; ref_fp: string | null; stage: string | null; payload_updated_at: string | null; cart_value: string | null; item_count: number | null; items_fp: string | null;
  fp_cart_id: string | null; fp_checkout_id: string | null; fp_session_id: string | null; fp_id: string | null; fp_cart_token: string | null; fp_token: string | null;
  phone_match: boolean; email_match: boolean;
}

// ---- Analysis -------------------------------------------------------------------------------------------------------------------------
export type Verdict = "SUPPORTED" | "NOT_SUPPORTED" | "UNDETERMINED";
export type Conclusion = "SAME_CHECKOUT_PROGRESSING" | "SEPARATE_SESSIONS" | "REPEATED_DELIVERIES" | "INCONCLUSIVE";

export interface HypothesisResult { verdict: Verdict; reasons: string[] }
export interface RecordLink {
  recordId: string; refFp: string | null; stage: string | null; createdAt: string; updatedAt: string;
  linkedEventIds: string[]; creationCandidateEventIds: string[];
  activityTitles: { at: string; title: string | null }[];
  latestLinkedEventStage: string | null;
}
export interface Analysis {
  conclusion: Conclusion;
  hypotheses: { sameCheckoutProgressing: HypothesisResult; separateSessions: HypothesisResult; repeatedDeliveries: HypothesisResult };
  recordLinks: RecordLink[];
  eventsMatched: number; eventsLinkedToARecord: number; eventsLinkedToNeither: string[];
  distinctReferenceFingerprints: string[];
  sharedStableKeys: RefKey[];
  referenceKeysUsed: RefKey[];
  intervalsInterleave: boolean | null;
  contentsIdentical: boolean | null;
  stagesMoveForward: boolean | null;
  caveats: string[];
}

export const STAGE_RANK: Record<string, number> = { ORDER_SCREEN: 1, PAYMENT_INITIATED: 2 };
/** Seconds after a record's created_at within which the event that created it is expected to have finished (the save has a 30 s transaction limit). */
export const CREATION_WINDOW_BEFORE_MS = 2_000;
export const CREATION_WINDOW_AFTER_MS = 120_000;

const FP_COLUMNS: Record<RefKey, keyof EventRow> = {
  cart_id: "fp_cart_id", checkout_id: "fp_checkout_id", session_id: "fp_session_id", id: "fp_id", cart_token: "fp_cart_token", token: "fp_token",
};

export const BASE_CAVEATS = [
  "There is no foreign key between a webhook event and an abandonment record; events are linked only by comparing short fingerprints of the cart reference the processor would have picked.",
  "Events are tied to the lead by phone/email equality evaluated inside the database. Deliveries with no usable contact, or contact stored in an unexpected shape, are not matched.",
  "Byte-identical repeat deliveries are rejected when recorded (same delivery id), so they never appear here; absence of repeats is not evidence none were sent.",
  "A reference field that stays constant may identify a session OR be a constant that is not session-specific; this report cannot tell which from one lead.",
  "Two different fingerprints do not prove two different carts, and identical timestamps do not prove a race.",
  "Event retention is unknown: events older than any cleanup are simply absent.",
];

const t = (d: Date) => d.getTime();
const sameSet = <T>(a: Set<T>) => a.size === 1;

export function analyze(records: RecordRow[], events: EventRow[], activities: ActivityRow[]): Analysis {
  const sorted = [...records].sort((a, b) => t(a.created_at) - t(b.created_at) || a.id.localeCompare(b.id));
  const byRecord = new Map<string, EventRow[]>();
  for (const r of sorted) byRecord.set(r.id, r.ref_fp ? events.filter((e) => e.ref_fp === r.ref_fp) : []);
  const linkedIds = new Set([...byRecord.values()].flat().map((e) => e.id));

  const recordLinks: RecordLink[] = sorted.map((r) => {
    const linked = byRecord.get(r.id)!;
    const lastLinked = [...linked].sort((a, b) => t(a.received_at) - t(b.received_at)).at(-1);
    return {
      recordId: r.id, refFp: r.ref_fp, stage: r.stage, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
      linkedEventIds: linked.map((e) => e.id),
      creationCandidateEventIds: linked.filter((e) => e.processed_at && t(e.processed_at) >= t(r.created_at) - CREATION_WINDOW_BEFORE_MS && t(e.processed_at) <= t(r.created_at) + CREATION_WINDOW_AFTER_MS).map((e) => e.id),
      activityTitles: activities.filter((a) => a.abandonment_id === r.id).map((a) => ({ at: a.created_at.toISOString(), title: a.title })),
      latestLinkedEventStage: lastLinked?.stage ?? null,
    };
  });

  const two = sorted.length === 2;
  const [first, second] = sorted;
  const groupA = two ? byRecord.get(first!.id)! : [];
  const groupB = two ? byRecord.get(second!.id)! : [];
  const linkedBoth = two && groupA.length > 0 && groupB.length > 0;
  const fpsDiffer = two && first!.ref_fp !== null && second!.ref_fp !== null && first!.ref_fp !== second!.ref_fp;
  const linkedEvents = linkedBoth ? [...groupA, ...groupB] : [];

  // Does any candidate identifier stay identical across every linked event of BOTH records?
  const sharedStableKeys: RefKey[] = [];
  if (linkedBoth && linkedEvents.length >= 2) {
    for (const key of REF_KEYS) {
      const col = FP_COLUMNS[key];
      const values = linkedEvents.map((e) => e[col] as string | null);
      if (values.every((v) => v !== null) && sameSet(new Set(values))) sharedStableKeys.push(key);
    }
  }
  // When the records have DIFFERENT chosen fingerprints, a stable key other than the chosen one is the interesting case.
  const referenceKeysUsed = [...new Set(linkedEvents.map((e) => e.ref_key).filter((k): k is RefKey => k !== null))];

  const span = (g: EventRow[]) => ({ lo: Math.min(...g.map((e) => t(e.received_at))), hi: Math.max(...g.map((e) => t(e.received_at))) });
  let interleave: boolean | null = null;
  if (linkedBoth) {
    const a = span(groupA), b = span(groupB);
    interleave = a.lo < b.hi && b.lo < a.hi;
  }

  let contentsIdentical: boolean | null = null;
  if (linkedBoth) {
    const items = new Set(linkedEvents.map((e) => e.items_fp));
    const values = new Set(linkedEvents.map((e) => e.cart_value));
    contentsIdentical = !items.has(null) && !values.has(null) && items.size === 1 && values.size === 1;
  }

  let stagesMoveForward: boolean | null = null;
  if (linkedBoth) {
    const ranks = [...linkedEvents].sort((a, b) => t(a.received_at) - t(b.received_at)).map((e) => (e.stage ? STAGE_RANK[e.stage] : undefined));
    stagesMoveForward = ranks.some((r) => r === undefined) ? null : ranks.every((r, i) => i === 0 || r! >= ranks[i - 1]!);
  }

  // --- hypothesis 1: one checkout moving between stages (its identifier changing or being read from a different field) ---
  const h1: HypothesisResult = { verdict: "UNDETERMINED", reasons: [] };
  if (!two) h1.reasons.push(`Expected exactly two records, got ${sorted.length}.`);
  else if (!linkedBoth) h1.reasons.push("No stored event carries the reference fingerprint of one or both records, so the two records cannot be compared event by event.");
  else {
    const shared = sharedStableKeys.length > 0;
    if (shared && interleave !== true) {
      h1.verdict = "SUPPORTED";
      h1.reasons.push(`Identifier field(s) [${sharedStableKeys.join(", ")}] hold the same value in every linked event of both records, while the chosen reference differs. (Caveat: that field may be a constant rather than session-specific.)`);
    } else if (!shared && interleave === false && contentsIdentical === true && stagesMoveForward === true) {
      h1.verdict = "SUPPORTED";
      h1.reasons.push("Events of the two references do not overlap in time, cart contents/value are identical, and known stages only move forward.");
    } else if (shared && interleave === true) {
      h1.reasons.push("Conflicting evidence: a shared identifier field exists, but the two references' events interleave in time.");
    } else {
      h1.reasons.push(shared ? "Shared identifier present but timing is not usable." : "No identifier field is shared by all linked events, and the secondary conditions (no overlap, identical contents, forward stages) are not all met.");
    }
  }

  // --- hypothesis 2: separate checkout sessions ---
  const h2: HypothesisResult = { verdict: "UNDETERMINED", reasons: [] };
  if (linkedBoth) {
    if (interleave === true && sharedStableKeys.length === 0) {
      h2.verdict = "SUPPORTED";
      h2.reasons.push("Events of the two references interleave in time and no identifier field is shared by all of them. (A customer with two tabs fits this; so does an identifier that changes mid-session.)");
    } else if (sharedStableKeys.length > 0 && interleave === false) {
      h2.verdict = "NOT_SUPPORTED";
      h2.reasons.push(`Field(s) [${sharedStableKeys.join(", ")}] are identical across both references' events and the events do not overlap.`);
    } else {
      h2.reasons.push("Overlap and shared-identifier evidence do not point one way.");
    }
  } else h2.reasons.push("Not enough linked events to compare the two references.");

  // --- hypothesis 3: repeated deliveries (a retry/duplicate of one reference) produced the second record ---
  const h3: HypothesisResult = { verdict: "UNDETERMINED", reasons: [] };
  if (!two) h3.reasons.push(`Expected exactly two records, got ${sorted.length}.`);
  else if (fpsDiffer) {
    h3.verdict = "NOT_SUPPORTED";
    h3.reasons.push("The two records carry different reference fingerprints; a repeat delivery of one reference is merged into one record by the ingest code and would not create a second row with another reference.");
  } else if (first!.ref_fp === second!.ref_fp) {
    const cands = new Set([...recordLinks[0]!.creationCandidateEventIds, ...recordLinks[1]!.creationCandidateEventIds]);
    h3.verdict = cands.size >= 2 ? "SUPPORTED" : "UNDETERMINED";
    h3.reasons.push(cands.size >= 2 ? "Both records share a reference and more than one delivery finished within the creation window of a record." : "Same reference on both records but the creating deliveries cannot be told apart.");
  } else h3.reasons.push("One or both records have no reference, so repeats cannot be matched to them.");

  const supported = (Object.entries({ SAME_CHECKOUT_PROGRESSING: h1, SEPARATE_SESSIONS: h2, REPEATED_DELIVERIES: h3 }) as [Conclusion, HypothesisResult][]).filter(([, h]) => h.verdict === "SUPPORTED");
  const conclusion: Conclusion = supported.length === 1 ? supported[0]![0] : "INCONCLUSIVE";

  return {
    conclusion,
    hypotheses: { sameCheckoutProgressing: h1, separateSessions: h2, repeatedDeliveries: h3 },
    recordLinks,
    eventsMatched: events.length,
    eventsLinkedToARecord: linkedIds.size,
    eventsLinkedToNeither: events.filter((e) => !linkedIds.has(e.id)).map((e) => e.id),
    distinctReferenceFingerprints: [...new Set(events.map((e) => e.ref_fp).filter((f): f is string => f !== null))],
    sharedStableKeys, referenceKeysUsed,
    intervalsInterleave: interleave, contentsIdentical, stagesMoveForward,
    caveats: [...BASE_CAVEATS, ...(events.length === 0 ? ["No stored webhook event matched this lead in the window - the result is inconclusive by absence of evidence, not evidence of absence."] : [])],
  };
}

export const CONCLUSION_WORDING: Record<Conclusion, string> = {
  SAME_CHECKOUT_PROGRESSING: "The stored evidence SUPPORTS (does not prove) one checkout whose identifier differed between stages.",
  SEPARATE_SESSIONS: "The stored evidence SUPPORTS (does not prove) two separate checkout sessions.",
  REPEATED_DELIVERIES: "The stored evidence SUPPORTS (does not prove) repeated deliveries of one reference creating both records.",
  INCONCLUSIVE: "INCONCLUSIVE: the stored evidence does not single out one explanation.",
};
