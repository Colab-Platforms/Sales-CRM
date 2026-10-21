// Pure logic for cart-token-validation.ts (no I/O). Question answered: is the Shiprocket/Fastrr `cart_token` a safe candidate for matching one checkout
// abandonment to another when `cart_id` changes? The report measures; it never matches or merges anything.
//
// FINGERPRINT METHOD (identical everywhere in this report and in the earlier reports): sha256 of the UTF-8 bytes of the trimmed value, hex-encoded, computed
// INSIDE PostgreSQL. All grouping and counting uses the FULL 64-hex hash (so a short-hash collision can never merge two different tokens); only the first 8
// hex characters are ever displayed. No raw token, payload, phone, email or name is selected, held or printed.
import { digits, emailExpr, phoneExpr, val } from "./abandonment-webhook-correlation.logic.js";

export const FINGERPRINT_METHOD = "sha256(utf8(trim(value))) hex, computed in PostgreSQL; grouping uses all 64 hex chars, display shows the first 8";

// ---- SQL (SELECT-only, parameterised) -------------------------------------------------------------------------------------------------
// $1 = sample cap: the most recent N 'checkout.abandoned' events of provider SHIPROCKET_CHECKOUT are examined (older ones are NOT).
export const PLACEHOLDERS = ["null", "undefined", "none", "nan", "n/a", "na", "nil", "0", "-", "false", "true", "test", "default", "token", "cart_token", "unknown"];

const tokType = "jsonb_typeof(w.payload -> 'cart_token')";
const tokVal = `(case when ${tokType} in ('string', 'number') then btrim(w.payload ->> 'cart_token') end)`;
const tokStatus = `(case
      when ${tokType} is null or ${tokType} = 'null' then 'MISSING'
      when ${tokType} not in ('string', 'number') then 'NON_SCALAR'
      when ${tokVal} = '' then 'EMPTY'
      when lower(${tokVal}) in (${PLACEHOLDERS.map((p) => `'${p}'`).join(", ")}) or ${tokVal} ~ '^(0+|x+|-+|[.]+|_+|[*]+)$' then 'PLACEHOLDER'
      when ${tokVal} !~ '^[A-Za-z0-9_.:=+/-]{8,128}$' then 'MALFORMED'
      else 'OK' end)`;
const cartType = "jsonb_typeof(w.payload -> 'cart_id')";
const cartVal = `(case when ${cartType} in ('string', 'number') then nullif(btrim(w.payload ->> 'cart_id'), '') end)`;
const cartStatus = `(case when ${cartType} is null or ${cartType} = 'null' then 'MISSING' when ${cartType} not in ('string', 'number') then 'NON_SCALAR' when ${cartVal} is null then 'EMPTY' else 'OK' end)`;
const sha = (e: string) => `encode(sha256(convert_to(${e}, 'UTF8')), 'hex')`;

const BASE = `with sample as (
    select w.id, w.received_at, w.event_type, w.payload
    from webhook_events w
    where w.provider = 'SHIPROCKET_CHECKOUT' and w.event_type = 'checkout.abandoned'
    order by w.received_at desc, w.id desc
    limit $1),
  ev as (
    select w.id, w.received_at, w.event_type,
      ${tokStatus} as tok_status,
      case when ${tokStatus} = 'OK' then ${sha(tokVal)} end as token_hash,
      case when ${tokStatus} = 'OK' then length(${tokVal}) end as tok_len,
      case when ${tokStatus} = 'OK' then (case
        when ${tokVal} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then 'uuid'
        when ${tokVal} ~ '^[0-9a-f]+$' then 'hex-lower'
        when ${tokVal} ~ '^[0-9A-Fa-f]+$' then 'hex-mixed'
        when ${tokVal} ~ '^[A-Za-z0-9]+$' then 'alnum'
        when ${tokVal} ~ '^[A-Za-z0-9_-]+$' then 'url-safe'
        else 'other-punctuation' end) end as tok_class,
      ${cartStatus} as cart_status,
      case when ${cartVal} is not null then ${sha(cartVal)} end as cart_hash,
      coalesce(${val("latest_stage")}, ${val("stage")}) as stage,
      ${digits(phoneExpr)} as phone10,
      lower(${emailExpr}) as email_lc
    from sample w),
  ev_lead as (
    select e.id as event_id, l.id as lead_id from ev e join leads l on l.normalized_email is not null and l.normalized_email = e.email_lc
    union
    select e.id as event_id, l.id as lead_id from ev e join leads l on e.phone10 is not null and length(e.phone10) = 10 and right(regexp_replace(l.normalized_mobile, '\\D', '', 'g'), 10) = e.phone10)`;

/** Whole-provider coverage plus what the sample holds. $1 = cap. */
export const COVERAGE_SQL = `${BASE}
  select (select count(*) from webhook_events where provider = 'SHIPROCKET_CHECKOUT' and event_type = 'checkout.abandoned') as total_events,
    (select min(received_at) from webhook_events where provider = 'SHIPROCKET_CHECKOUT' and event_type = 'checkout.abandoned') as total_oldest,
    count(*) as sample_events, min(e.received_at) as sample_oldest, max(e.received_at) as sample_newest,
    count(*) filter (where e.phone10 is not null or e.email_lc is not null) as events_with_contact,
    (select count(distinct event_id) from ev_lead) as events_with_lead
  from ev e`;

/** Token and cart-id presence by status. $1 = cap. */
export const PRESENCE_SQL = `${BASE}
  select 'cart_token' as field, tok_status as status, count(*) as n from ev group by 2
  union all
  select 'cart_id' as field, cart_status as status, count(*) as n from ev group by 2`;

/** Shape of well-formed tokens: character class and length only. $1 = cap. */
export const FORMAT_SQL = `${BASE}
  select tok_class, tok_len, count(*) as n from ev where tok_status = 'OK' group by 1, 2 order by 3 desc, 1, 2 limit 30`;

/** One row per well-formed token (display fingerprint only). $1 = cap, $2 = max token rows. */
export const TOKENS_SQL = `${BASE},
  tok as (
    select token_hash, count(*) as n_events, min(received_at) as first_at, max(received_at) as last_at,
      count(distinct cart_hash) as n_carts, count(*) filter (where cart_hash is null) as n_events_no_cart,
      count(distinct stage) as n_stages, count(distinct event_type) as n_event_types,
      count(distinct coalesce(phone10, email_lc)) as n_contacts, count(*) filter (where phone10 is null and email_lc is null) as n_events_no_contact
    from ev where token_hash is not null group by 1),
  tok_lead as (select e.token_hash, el.lead_id from ev e join ev_lead el on el.event_id = e.id where e.token_hash is not null group by 1, 2),
  tok_lead_events as (select e.token_hash, count(distinct e.id) as n_events_with_lead from ev e join ev_lead el on el.event_id = e.id where e.token_hash is not null group by 1),
  assoc as (
    select tl.token_hash,
      sum((select count(*) from orders o where o.lead_id = tl.lead_id and o.status <> 'DRAFT' and coalesce(o.placed_at, o.created_at) > t.first_at and coalesce(o.placed_at, o.created_at) < t.last_at)) as orders_inside,
      sum((select count(*) from abandonments a where a.lead_id = tl.lead_id and a.type = 'CHECKOUT' and a.status = 'RECOVERED' and a.recovered_at > t.first_at and a.recovered_at < t.last_at)) as recovered_inside,
      sum((select count(*) from abandonments a where a.lead_id = tl.lead_id and a.type = 'CHECKOUT' and a.status in ('EXPIRED', 'NOT_RECOVERED') and a.updated_at > t.first_at and a.updated_at < t.last_at)) as closed_inside_proxy
    from tok_lead tl join tok t on t.token_hash = tl.token_hash group by 1)
  select left(t.token_hash, 8) as token_fp, t.n_events, t.first_at, t.last_at, t.n_carts, t.n_events_no_cart, t.n_stages, t.n_event_types, t.n_contacts, t.n_events_no_contact,
    coalesce(tle.n_events_with_lead, 0) as n_events_with_lead,
    (select count(*) from tok_lead x where x.token_hash = t.token_hash) as n_leads,
    coalesce(a.orders_inside, 0) as orders_inside, coalesce(a.recovered_inside, 0) as recovered_inside, coalesce(a.closed_inside_proxy, 0) as closed_inside_proxy
  from tok t left join tok_lead_events tle on tle.token_hash = t.token_hash left join assoc a on a.token_hash = t.token_hash
  order by t.n_events desc, t.first_at asc, t.token_hash
  limit $2`;

/** Cart ids mapped to more than one token (counts). $1 = cap. */
export const CARTS_SQL = `${BASE}
  select count(*) as total_carts, count(*) filter (where n_tokens > 1) as multi_token_carts, coalesce(max(n_tokens), 0) as max_tokens_per_cart,
    count(*) filter (where n_tokens = 0) as carts_without_ok_token
  from (select cart_hash, count(distinct token_hash) as n_tokens from ev where cart_hash is not null group by 1) c`;

/** Up to 20 cart ids with several tokens (display fingerprints only). $1 = cap. */
export const CARTS_DETAIL_SQL = `${BASE}
  select left(cart_hash, 8) as cart_fp, count(distinct token_hash) as n_tokens, count(*) as n_events, min(received_at) as first_at, max(received_at) as last_at
  from ev where cart_hash is not null group by cart_hash having count(distinct token_hash) > 1 order by 2 desc, 3 desc, cart_hash limit 20`;

/** Events (within the sample) that created/refreshed the given abandonment records, by cart-id hash and the lead's identity, with the token's global footprint. $1 = cap, $2 = record ids. */
export const OBSERVED_SQL = `${BASE},
  obs as (
    select e.id, e.received_at, e.stage, e.cart_hash, e.token_hash, e.tok_status, a.id as record_id
    from ev e join ev_lead el on el.event_id = e.id
    join abandonments a on a.id = any($2::uuid[]) and a.lead_id = el.lead_id and a.reference_id is not null and e.cart_hash = ${sha("a.reference_id")}),
  tok as (
    select e.token_hash, count(*) as n_events, count(distinct e.cart_hash) as n_carts, min(e.received_at) as first_at, max(e.received_at) as last_at,
      (select count(distinct x.lead_id) from ev_lead x join ev e2 on e2.id = x.event_id where e2.token_hash = e.token_hash) as n_leads
    from ev e where e.token_hash in (select token_hash from obs where token_hash is not null) group by e.token_hash)
  select o.id as event_id, o.record_id, o.received_at, o.stage, left(o.cart_hash, 8) as cart_fp, o.tok_status, left(o.token_hash, 8) as token_fp,
    t.n_events as token_events, t.n_carts as token_carts, t.n_leads as token_leads, t.first_at as token_first_at, t.last_at as token_last_at
  from obs o left join tok t on t.token_hash = o.token_hash
  order by o.received_at asc, o.id asc`;

export const ALL_SQL = [COVERAGE_SQL, PRESENCE_SQL, FORMAT_SQL, TOKENS_SQL, CARTS_SQL, CARTS_DETAIL_SQL, OBSERVED_SQL];
export const READ_SETUP = ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '120s'"] as const;
export const DEFAULT_SAMPLE_CAP = 50_000;
export const MAX_SAMPLE_CAP = 200_000;
export const clampCap = (raw: unknown): number => Math.min(MAX_SAMPLE_CAP, Math.max(100, Math.floor(Number(raw)) || DEFAULT_SAMPLE_CAP));

// ---- Rows -----------------------------------------------------------------------------------------------------------------------------
type Num = number | string | bigint | null;
export const num = (v: Num | undefined): number => (v === null || v === undefined ? 0 : Number(v));

export interface CoverageRow { total_events: Num; total_oldest: Date | null; sample_events: Num; sample_oldest: Date | null; sample_newest: Date | null; events_with_contact: Num; events_with_lead: Num }
export interface PresenceRow { field: "cart_token" | "cart_id"; status: string; n: Num }
export interface FormatRow { tok_class: string; tok_len: Num; n: Num }
export interface TokenRow {
  token_fp: string; n_events: Num; first_at: Date; last_at: Date; n_carts: Num; n_events_no_cart: Num; n_stages: Num; n_event_types: Num; n_contacts: Num; n_events_no_contact: Num;
  n_events_with_lead: Num; n_leads: Num; orders_inside: Num; recovered_inside: Num; closed_inside_proxy: Num;
}
export interface CartsRow { total_carts: Num; multi_token_carts: Num; max_tokens_per_cart: Num; carts_without_ok_token: Num }
export interface ObservedRow {
  event_id: string; record_id: string; received_at: Date; stage: string | null; cart_fp: string | null; tok_status: string; token_fp: string | null;
  token_events: Num; token_carts: Num; token_leads: Num; token_first_at: Date | null; token_last_at: Date | null;
}

// ---- Analysis -------------------------------------------------------------------------------------------------------------------------
export interface Coverage {
  totalEvents: number; sampleEvents: number; sampleCap: number; capReached: boolean;
  oldest: string | null; newest: string | null; rangeDays: number | null; eventsWithContactShare: number; eventsWithLeadShare: number;
}
export function assessCoverage(r: CoverageRow, cap: number): Coverage {
  const sample = num(r.sample_events), total = num(r.total_events);
  const range = r.sample_oldest && r.sample_newest ? (r.sample_newest.getTime() - r.sample_oldest.getTime()) / 86_400_000 : null;
  return {
    totalEvents: total, sampleEvents: sample, sampleCap: cap,
    // Everything beyond the cap is unexamined, and the examined set is the NEWEST events, so token lifetimes are cut off at its oldest edge.
    capReached: total > sample,
    oldest: r.sample_oldest?.toISOString() ?? null, newest: r.sample_newest?.toISOString() ?? null, rangeDays: range === null ? null : Math.round(range * 10) / 10,
    eventsWithContactShare: sample ? num(r.events_with_contact) / sample : 0,
    eventsWithLeadShare: sample ? num(r.events_with_lead) / sample : 0,
  };
}

export function summarizePresence(rows: PresenceRow[]) {
  const of = (field: string) => Object.fromEntries(rows.filter((r) => r.field === field).map((r) => [r.status, num(r.n)])) as Record<string, number>;
  const token = of("cart_token"), cartId = of("cart_id");
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const tokenTotal = sum(token), cartTotal = sum(cartId);
  const bad = tokenTotal - (token.OK ?? 0);
  return {
    token: { total: tokenTotal, ok: token.OK ?? 0, missing: token.MISSING ?? 0, empty: token.EMPTY ?? 0, placeholder: token.PLACEHOLDER ?? 0, malformed: (token.MALFORMED ?? 0) + (token.NON_SCALAR ?? 0), notOk: bad, okShare: tokenTotal ? (token.OK ?? 0) / tokenTotal : 0 },
    cartId: { total: cartTotal, ok: cartId.OK ?? 0, notOk: cartTotal - (cartId.OK ?? 0), okShare: cartTotal ? (cartId.OK ?? 0) / cartTotal : 0 },
  };
}

export function summarizeFormat(rows: FormatRow[], okTotal: number) {
  const entries = rows.map((r) => ({ charset: r.tok_class, length: num(r.tok_len), n: num(r.n) })).sort((a, b) => b.n - a.n);
  const top = entries[0];
  const share = top && okTotal > 0 ? top.n / okTotal : 0;
  return { distinctShapes: entries.length, dominant: top ? { ...top, share } : null, consistent: share >= FORMAT_CONSISTENT_SHARE, distribution: entries };
}

export const FORMAT_CONSISTENT_SHARE = 0.95;

const quantile = (sorted: number[], q: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);

export interface TokenView {
  fp: string; events: number; firstAt: string; lastAt: string; spanSeconds: number; carts: number; stages: number; eventTypes: number; contacts: number; leads: number;
  eventsWithLead: number; eventsWithoutLead: number; ordersInside: number; recoveredInside: number; closedInsideProxy: number;
}
export const toTokenView = (r: TokenRow): TokenView => ({
  fp: r.token_fp, events: num(r.n_events), firstAt: r.first_at.toISOString(), lastAt: r.last_at.toISOString(),
  spanSeconds: Math.max(0, Math.round((r.last_at.getTime() - r.first_at.getTime()) / 1000)),
  carts: num(r.n_carts), stages: num(r.n_stages), eventTypes: num(r.n_event_types), contacts: num(r.n_contacts), leads: num(r.n_leads),
  eventsWithLead: num(r.n_events_with_lead), eventsWithoutLead: num(r.n_events) - num(r.n_events_with_lead),
  ordersInside: num(r.orders_inside), recoveredInside: num(r.recovered_inside), closedInsideProxy: num(r.closed_inside_proxy),
});

export const LIFETIME_BUCKETS = [["single event", 0], ["under 1 hour", 3600], ["1 to 24 hours", 86_400], ["1 to 7 days", 604_800], ["over 7 days", Infinity]] as const;

export function lifetimeStats(tokens: TokenView[]) {
  const multi = tokens.filter((t) => t.events > 1);
  const spans = multi.map((t) => t.spanSeconds).sort((a, b) => a - b);
  const buckets: Record<string, number> = Object.fromEntries(LIFETIME_BUCKETS.map(([k]) => [k, 0]));
  for (const t of tokens) {
    const key = t.events <= 1 ? "single event" : (LIFETIME_BUCKETS.slice(1).find(([, max]) => t.spanSeconds < max) ?? LIFETIME_BUCKETS.at(-1)!)[0];
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return {
    tokens: tokens.length, singleEventTokens: tokens.length - multi.length, multiEventTokens: multi.length,
    spanSecondsMedian: quantile(spans, 0.5), spanSecondsP95: quantile(spans, 0.95), spanSecondsMax: spans.at(-1) ?? null,
    maxEventsPerToken: tokens.reduce((m, t) => Math.max(m, t.events), 0), buckets,
    withSeveralStages: multi.filter((t) => t.stages > 1).length,
  };
}

export function sharingStats(tokens: TokenView[]) {
  return {
    tokensSeenWithMultipleLeads: tokens.filter((t) => t.leads > 1).length,
    tokensSeenWithMultipleContacts: tokens.filter((t) => t.contacts > 1).length,
    tokensWithNoLeadAssociation: tokens.filter((t) => t.leads === 0).length,
    tokensWithSingleLead: tokens.filter((t) => t.leads === 1).length,
    // A token seen under one lead today says nothing about tomorrow: this count is "observed", never "unique".
    note: "Counts are observations inside the examined window only; a token seen under one lead is not shown to be unique to it.",
  };
}

export function cardinalityStats(tokens: TokenView[], carts: CartsRow | null) {
  return {
    tokensWithSeveralCartIds: tokens.filter((t) => t.carts > 1).length,
    tokensWithOneCartId: tokens.filter((t) => t.carts === 1).length,
    tokensWithEventsLackingCartId: tokens.filter((t) => t.carts === 0).length,
    maxCartIdsPerToken: tokens.reduce((m, t) => Math.max(m, t.carts), 0),
    cartIds: carts ? { total: num(carts.total_carts), withSeveralTokens: num(carts.multi_token_carts), maxTokensPerCart: num(carts.max_tokens_per_cart), withoutWellFormedToken: num(carts.carts_without_ok_token) } : null,
  };
}

export type Association = "NO_LEAD_LINK" | "AMBIGUOUS_MULTI_LEAD" | "SINGLE_LEAD";
export interface TokenAssociation { kind: Association; spansOrder: boolean; spansRecovered: boolean; spansClosedProxy: boolean }

/** Orders and abandonments are tied to a token only through the lead (events carry no order/abandonment foreign key, and the lead link itself is a phone/email match).
 *  So a relationship is reported ONLY for a token seen under exactly one lead; with several leads it is ambiguous and nothing is inferred. "Spans" means the order was
 *  placed / the abandonment closed strictly between the token's first and last event: co-occurrence in time for the same lead, not proof the order came from that checkout.
 *  Abandonments that are EXPIRED / NOT_RECOVERED have no closing timestamp in the schema, so updated_at is used as a proxy and reported separately. */
export function associate(t: TokenView): TokenAssociation {
  if (t.leads === 0) return { kind: "NO_LEAD_LINK", spansOrder: false, spansRecovered: false, spansClosedProxy: false };
  if (t.leads > 1) return { kind: "AMBIGUOUS_MULTI_LEAD", spansOrder: false, spansRecovered: false, spansClosedProxy: false };
  return { kind: "SINGLE_LEAD", spansOrder: t.ordersInside > 0, spansRecovered: t.recoveredInside > 0, spansClosedProxy: t.closedInsideProxy > 0 };
}

export function associationStats(tokens: TokenView[]) {
  const a = tokens.filter((t) => t.events > 1).map(associate);
  return {
    evaluatedMultiEventTokens: a.length,
    singleLead: a.filter((x) => x.kind === "SINGLE_LEAD").length,
    ambiguousMultiLead: a.filter((x) => x.kind === "AMBIGUOUS_MULTI_LEAD").length,
    noLeadLink: a.filter((x) => x.kind === "NO_LEAD_LINK").length,
    spanningAnOrder: a.filter((x) => x.spansOrder).length,
    spanningARecoveredAbandonment: a.filter((x) => x.spansRecovered).length,
    spanningAClosedAbandonmentByProxy: a.filter((x) => x.spansClosedProxy).length,
  };
}

export function observedPair(rows: ObservedRow[]) {
  if (rows.length === 0) return { found: false as const, events: [], sharesToken: null, tokenFingerprints: [] as string[], note: "No event in the examined window was linked to those records (they may be outside the sample, or the contact did not match)." };
  const tokens = [...new Set(rows.map((r) => r.token_fp).filter((f): f is string => f !== null))];
  const carts = new Set(rows.map((r) => r.cart_fp));
  const recordCount = new Set(rows.map((r) => r.record_id)).size;
  const everyHasToken = rows.every((r) => r.tok_status === "OK" && r.token_fp !== null);
  return {
    found: true as const,
    events: rows.map((r) => ({
      eventId: r.event_id, recordId: r.record_id, receivedAt: r.received_at.toISOString(), stage: r.stage, cartFp: r.cart_fp, tokenStatus: r.tok_status, tokenFp: r.token_fp,
      tokenEventsGlobal: r.token_events === null ? null : num(r.token_events), tokenCartIdsGlobal: r.token_carts === null ? null : num(r.token_carts), tokenLeadsGlobal: r.token_leads === null ? null : num(r.token_leads),
    })),
    // null = cannot say (a missing/odd token on some event, or fewer than two records linked) - never "false" by default
    sharesToken: everyHasToken && recordCount >= 2 ? tokens.length === 1 : null,
    distinctCartFingerprints: carts.size,
    tokenFingerprints: tokens,
    note: "Whether this token also appears elsewhere is in tokenEventsGlobal / tokenLeadsGlobal; the global findings above do not depend on this pair.",
  };
}

// ---- Recommendation -------------------------------------------------------------------------------------------------------------------
export const MIN_SAMPLE_EVENTS = 500;
export const MIN_RANGE_DAYS = 14;
export const MIN_MULTI_EVENT_TOKENS = 30;
export const MIN_OK_SHARE = 0.9;
export const MIN_LEAD_LINK_SHARE = 0.8;

export type Verdict = "INCONCLUSIVE" | "NOT_RECOMMENDED" | "CANDIDATE_WITH_GUARDS";
export interface Recommendation { verdict: Verdict; reasons: string[]; limitations: string[] }

export interface RecommendationInput {
  coverage: Coverage; presence: ReturnType<typeof summarizePresence>; format: ReturnType<typeof summarizeFormat>;
  lifetime: ReturnType<typeof lifetimeStats>; sharing: ReturnType<typeof sharingStats>; association: ReturnType<typeof associationStats>;
  tokenRowsTruncated: boolean;
}

export const STANDING_LIMITATIONS = [
  "Events are tied to leads by phone/email equality (a heuristic); orders and abandonments are tied to a token only through that lead, never by a foreign key.",
  "Absence of evidence is not evidence of non-reuse: tokens with a single event, events without a cart id, and events with no lead link say nothing about reuse.",
  "A token seen under one lead in this window is not shown to be globally unique, and the window is a snapshot of recent data, not of the token's future behaviour.",
  "Event retention is unknown; older events may have been removed.",
  "No provider documentation for `cart_token` exists in the repo; its meaning (cart vs browser vs checkout session) is not established by this report.",
];

export function recommend(i: RecommendationInput): Recommendation {
  const insufficient: string[] = [];
  const { coverage: c, presence: p } = i;
  if (c.capReached) insufficient.push(`Row cap reached: only the newest ${c.sampleEvents} of ${c.totalEvents} events were examined, so lifetimes are cut off at the window's oldest edge. Re-run with a larger --cap.`);
  if (i.tokenRowsTruncated) insufficient.push("The per-token list was truncated by its own row cap, so token statistics are incomplete.");
  if (c.sampleEvents < MIN_SAMPLE_EVENTS) insufficient.push(`Only ${c.sampleEvents} events examined (need at least ${MIN_SAMPLE_EVENTS}).`);
  if (c.rangeDays === null || c.rangeDays < MIN_RANGE_DAYS) insufficient.push(`Examined time range is ${c.rangeDays ?? "unknown"} days (need at least ${MIN_RANGE_DAYS}).`);
  if (p.token.total > 0 && p.token.okShare < MIN_OK_SHARE) insufficient.push(`Only ${(p.token.okShare * 100).toFixed(1)}% of events carry a well-formed cart_token (need ${MIN_OK_SHARE * 100}%): missing, empty, placeholder or malformed tokens are common.`);
  if (i.lifetime.multiEventTokens < MIN_MULTI_EVENT_TOKENS) insufficient.push(`Only ${i.lifetime.multiEventTokens} tokens appear in more than one event (need ${MIN_MULTI_EVENT_TOKENS}) - too few to observe reuse.`);
  if (c.eventsWithLeadShare < MIN_LEAD_LINK_SHARE) insufficient.push(`Only ${(c.eventsWithLeadShare * 100).toFixed(1)}% of events could be tied to a lead (need ${MIN_LEAD_LINK_SHARE * 100}%): cross-customer sharing and order/recovery overlap are under-observed.`);
  if (insufficient.length > 0) return { verdict: "INCONCLUSIVE", reasons: insufficient, limitations: STANDING_LIMITATIONS };

  const against: string[] = [];
  if (i.sharing.tokensSeenWithMultipleLeads > 0) against.push(`${i.sharing.tokensSeenWithMultipleLeads} token(s) were seen under more than one lead: the token is not specific to one customer.`);
  if (!i.format.consistent) against.push("Token format is not consistent (no single character-class/length covers 95% of tokens).");
  if (i.association.spanningAnOrder > 0) against.push(`${i.association.spanningAnOrder} single-lead token(s) outlive an order placed by the same lead between their first and last event: the token appears to identify a cart/browser rather than one checkout (co-occurrence, not proof).`);
  if (against.length > 0) return { verdict: "NOT_RECOMMENDED", reasons: against, limitations: STANDING_LIMITATIONS };

  const notes = [
    "Nothing in the examined window disqualifies the token, which is NOT evidence that it is safe.",
    `Observed multi-event token lifetime: median ${i.lifetime.spanSecondsMedian ?? "n/a"} s, 95th percentile ${i.lifetime.spanSecondsP95 ?? "n/a"} s, max ${i.lifetime.spanSecondsMax ?? "n/a"} s - any matching rule would need an age bound derived from these.`,
  ];
  if (i.association.spanningARecoveredAbandonment + i.association.spanningAClosedAbandonmentByProxy > 0) notes.push("Some tokens outlive a recovered/closed abandonment: a rule must never reopen a closed record and must start a new record after one.");
  return { verdict: "CANDIDATE_WITH_GUARDS", reasons: notes, limitations: STANDING_LIMITATIONS };
}
