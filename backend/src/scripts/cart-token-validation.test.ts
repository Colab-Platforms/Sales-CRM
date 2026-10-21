import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertSelectOnly } from "./abandonment-duplicates-report.logic.js";
import {
  ALL_SQL, FORMAT_SQL, OBSERVED_SQL, PLACEHOLDERS, STANDING_LIMITATIONS, TOKENS_SQL, assessCoverage, associate, associationStats, cardinalityStats, clampCap, lifetimeStats,
  observedPair, recommend, sharingStats, summarizeFormat, summarizePresence, toTokenView,
  type CoverageRow, type ObservedRow, type PresenceRow, type TokenRow, type TokenView,
} from "./cart-token-validation.logic.js";

const d = (s: string) => new Date(`2026-10-${s}Z`);
const tokenRow = (over: Partial<TokenRow> = {}): TokenRow => ({
  token_fp: "1101af3b", n_events: 2, first_at: d("18T13:11:00"), last_at: d("18T13:21:00"), n_carts: 2, n_events_no_cart: 0, n_stages: 2, n_event_types: 1, n_contacts: 1, n_events_no_contact: 0,
  n_events_with_lead: 2, n_leads: 1, orders_inside: 0, recovered_inside: 0, closed_inside_proxy: 0, ...over,
});
const tv = (over: Partial<TokenRow> = {}): TokenView => toTokenView(tokenRow(over));

describe("SQL safety", () => {
  it("every query is a single read-only SELECT/WITH statement", () => {
    for (const sql of ALL_SQL) assert.doesNotThrow(() => assertSelectOnly(sql));
  });

  it("only fingerprints leave the database: no payload, raw token, cart id, phone, email or name is projected", () => {
    for (const sql of ALL_SQL) {
      const finalSelect = sql.slice(sql.lastIndexOf("\n  select") >= 0 ? sql.lastIndexOf("\n  select") : 0);
      assert.equal(/\bpayload\b/.test(finalSelect.replace(/w\.payload/g, "")), false);
      assert.equal(/\b(tok_val|phone10|email_lc|normalized_mobile|normalized_email|first_name|last_name)\b/.test(finalSelect.split(/\bfrom\b/i)[0]!), false);
    }
    // displayed fingerprints are the first 8 hex chars of the full hash; grouping is on the full hash
    for (const sql of [TOKENS_SQL, OBSERVED_SQL]) assert.match(sql, /left\((t|o)\.(token_hash|cart_hash), 8\)/);
    assert.match(TOKENS_SQL, /group by 1\),\s*tok_lead/);
    assert.equal(/group by left\(/.test(TOKENS_SQL), false);
  });

  it("uses one fingerprint method everywhere and the sample is capped and provider-scoped", () => {
    for (const sql of ALL_SQL) {
      assert.match(sql, /encode\(sha256\(convert_to\(/);
      assert.match(sql, /provider = 'SHIPROCKET_CHECKOUT'/);
      assert.match(sql, /limit \$1/);
    }
  });

  it("the placeholder list is lower-case and covers the usual junk values", () => {
    for (const p of ["null", "undefined", "0", "test"]) assert.ok(PLACEHOLDERS.includes(p));
    assert.ok(PLACEHOLDERS.every((p) => p === p.toLowerCase()));
    assert.match(TOKENS_SQL, /'MALFORMED'/);
  });

  it("the shape query reports character class and length only", () => {
    assert.match(FORMAT_SQL, /select tok_class, tok_len, count\(\*\)/);
  });

  it("the runner confirms the host, goes read-only first, rolls back and prints no connection details or raw query parameters", () => {
    const src = readFileSync(new URL("./cart-token-validation.ts", import.meta.url), "utf8");
    assert.match(src, /hostMatches\(target\.host, arg\("expect-host"\)\)/);
    assert.ok(src.indexOf("default_transaction_read_only = on") < src.indexOf("client.query(COVERAGE_SQL"));
    assert.match(src, /ROLLBACK/);
    for (const line of src.split("\n").filter((l) => /console\.(log|error|table)/.test(l))) assert.equal(/connectionString|process\.env|recordIds|rawRecordIds|String\(error|error\.message/.test(line), false, line);
  });

  it("the sample cap is clamped", () => {
    assert.equal(clampCap(undefined), 50_000);
    assert.equal(clampCap("abc"), 50_000);
    assert.equal(clampCap(5), 100);
    assert.equal(clampCap(9_999_999), 200_000);
  });
});

describe("presence and format", () => {
  const rows: PresenceRow[] = [
    { field: "cart_token", status: "OK", n: "80" }, { field: "cart_token", status: "MISSING", n: 10 }, { field: "cart_token", status: "EMPTY", n: 4 },
    { field: "cart_token", status: "PLACEHOLDER", n: 3 }, { field: "cart_token", status: "MALFORMED", n: 2 }, { field: "cart_token", status: "NON_SCALAR", n: 1 },
    { field: "cart_id", status: "OK", n: 95 }, { field: "cart_id", status: "MISSING", n: 5 },
  ];

  it("separates missing, empty, placeholder and malformed tokens, and never counts them as OK", () => {
    const s = summarizePresence(rows);
    assert.deepEqual({ ok: s.token.ok, missing: s.token.missing, empty: s.token.empty, placeholder: s.token.placeholder, malformed: s.token.malformed, total: s.token.total }, { ok: 80, missing: 10, empty: 4, placeholder: 3, malformed: 3, total: 100 });
    assert.equal(s.token.okShare, 0.8);
    assert.equal(s.cartId.notOk, 5);
  });

  it("judges the format consistent only when one class/length dominates", () => {
    assert.equal(summarizeFormat([{ tok_class: "hex-lower", tok_len: 32, n: 96 }, { tok_class: "alnum", tok_len: 24, n: 4 }], 100).consistent, true);
    const mixed = summarizeFormat([{ tok_class: "hex-lower", tok_len: 32, n: 60 }, { tok_class: "alnum", tok_len: 24, n: 40 }], 100);
    assert.equal(mixed.consistent, false);
    assert.equal(mixed.dominant?.length, 32);
    assert.equal(summarizeFormat([], 0).consistent, false);
  });
});

describe("sharing and cardinality", () => {
  it("counts tokens seen under several leads or contacts, and keeps 'no lead link' separate from 'one lead'", () => {
    const s = sharingStats([tv({ n_leads: 3 }), tv({ n_leads: 1, n_contacts: 2 }), tv({ n_leads: 1 }), tv({ n_leads: 0, n_events_with_lead: 0 })]);
    assert.equal(s.tokensSeenWithMultipleLeads, 1);
    assert.equal(s.tokensSeenWithMultipleContacts, 1);
    assert.equal(s.tokensWithSingleLead, 2);
    assert.equal(s.tokensWithNoLeadAssociation, 1);
    assert.match(s.note, /not shown to be unique/);
  });

  it("counts token-to-cart and cart-to-token cardinality, treating events without a cart id separately", () => {
    const c = cardinalityStats([tv({ n_carts: 2 }), tv({ n_carts: 1 }), tv({ n_carts: 0 }), tv({ n_carts: 4 })], { total_carts: "10", multi_token_carts: "2", max_tokens_per_cart: "3", carts_without_ok_token: "1" });
    assert.equal(c.tokensWithSeveralCartIds, 2);
    assert.equal(c.tokensWithOneCartId, 1);
    assert.equal(c.tokensWithEventsLackingCartId, 1);
    assert.equal(c.maxCartIdsPerToken, 4);
    assert.deepEqual(c.cartIds, { total: 10, withSeveralTokens: 2, maxTokensPerCart: 3, withoutWellFormedToken: 1 });
    assert.equal(cardinalityStats([], null).cartIds, null);
  });
});

describe("lifetime", () => {
  it("computes spans in seconds, buckets them, and keeps single-event tokens out of the span statistics", () => {
    const tokens = [
      tv({ n_events: 1, first_at: d("18T10:00:00"), last_at: d("18T10:00:00") }),
      tv({ n_events: 2, first_at: d("18T10:00:00"), last_at: d("18T10:10:00") }),
      tv({ n_events: 3, first_at: d("18T10:00:00"), last_at: d("18T20:00:00") }),
      tv({ n_events: 2, first_at: d("10T10:00:00"), last_at: d("18T10:00:00") }),
    ];
    assert.equal(tokens[1]!.spanSeconds, 600);
    const l = lifetimeStats(tokens);
    assert.equal(l.singleEventTokens, 1);
    assert.equal(l.multiEventTokens, 3);
    assert.deepEqual(l.buckets, { "single event": 1, "under 1 hour": 1, "1 to 24 hours": 1, "1 to 7 days": 0, "over 7 days": 1 });
    assert.equal(l.spanSecondsMax, 8 * 86_400);
    assert.equal(l.spanSecondsMedian, 36_000);
    assert.equal(l.maxEventsPerToken, 3);
  });

  it("an empty set yields nulls, not zeros", () => {
    const l = lifetimeStats([]);
    assert.equal(l.spanSecondsMedian, null);
    assert.equal(l.spanSecondsMax, null);
  });
});

describe("order / recovery association", () => {
  it("is reported only for a token under exactly one lead", () => {
    assert.deepEqual(associate(tv({ n_leads: 1, orders_inside: 1, recovered_inside: 1, closed_inside_proxy: 2 })), { kind: "SINGLE_LEAD", spansOrder: true, spansRecovered: true, spansClosedProxy: true });
    assert.deepEqual(associate(tv({ n_leads: 2, orders_inside: 5 })), { kind: "AMBIGUOUS_MULTI_LEAD", spansOrder: false, spansRecovered: false, spansClosedProxy: false });
    assert.equal(associate(tv({ n_leads: 0, orders_inside: 5 })).kind, "NO_LEAD_LINK");
  });

  it("only multi-event tokens are evaluated, and a token with no overlap is not flagged", () => {
    const s = associationStats([tv({ n_events: 1, orders_inside: 1 }), tv({ n_leads: 1, orders_inside: 1 }), tv({ n_leads: 1 }), tv({ n_leads: 2, orders_inside: 3 })]);
    assert.equal(s.evaluatedMultiEventTokens, 3);
    assert.equal(s.spanningAnOrder, 1);
    assert.equal(s.ambiguousMultiLead, 1);
    assert.equal(s.singleLead, 2);
  });

  it("keeps recovered (has a timestamp) apart from expired / not-recovered (updated_at proxy)", () => {
    const s = associationStats([tv({ recovered_inside: 1 }), tv({ closed_inside_proxy: 1 })]);
    assert.equal(s.spanningARecoveredAbandonment, 1);
    assert.equal(s.spanningAClosedAbandonmentByProxy, 1);
  });
});

describe("the observed pair", () => {
  const obs = (over: Partial<ObservedRow> = {}): ObservedRow => ({
    event_id: "E1", record_id: "R1", received_at: d("18T13:11:35"), stage: "PAYMENT_INITIATED", cart_fp: "28046782", tok_status: "OK", token_fp: "1101af3b",
    token_events: 2, token_carts: 2, token_leads: 1, token_first_at: d("18T13:11:35"), token_last_at: d("18T13:21:09"), ...over,
  });

  it("reports a shared token across the two records together with its global footprint", () => {
    const r = observedPair([obs(), obs({ event_id: "E2", record_id: "R2", cart_fp: "0b276dc1", stage: "ORDER_SCREEN" })]);
    assert.equal(r.found, true);
    assert.equal(r.sharesToken, true);
    assert.deepEqual(r.tokenFingerprints, ["1101af3b"]);
    assert.equal(r.events[0]!.tokenLeadsGlobal, 1);
  });

  it("different tokens are 'false'; a missing token or a single record is 'cannot say', never false", () => {
    assert.equal(observedPair([obs(), obs({ event_id: "E2", record_id: "R2", token_fp: "deadbeef" })]).sharesToken, false);
    assert.equal(observedPair([obs(), obs({ event_id: "E2", record_id: "R2", tok_status: "MISSING", token_fp: null })]).sharesToken, null);
    assert.equal(observedPair([obs()]).sharesToken, null);
  });

  it("reports when no event could be linked rather than guessing", () => {
    const r = observedPair([]);
    assert.equal(r.found, false);
    assert.match(r.note, /outside the sample/);
  });
});

describe("recommendation", () => {
  const cov = (over: Partial<Parameters<typeof recommend>[0]["coverage"]> = {}) => ({
    totalEvents: 5000, sampleEvents: 5000, sampleCap: 50_000, capReached: false, oldest: "a", newest: "b", rangeDays: 60, eventsWithContactShare: 1, eventsWithLeadShare: 0.95, ...over,
  });
  const good = () => {
    const tokens = Array.from({ length: 60 }, (_, i) => tv({ token_fp: `t${i}`, n_leads: 1 }));
    const presence = summarizePresence([{ field: "cart_token", status: "OK", n: 950 }, { field: "cart_token", status: "MISSING", n: 50 }, { field: "cart_id", status: "OK", n: 1000 }]);
    return {
      coverage: cov(), presence, format: summarizeFormat([{ tok_class: "hex-lower", tok_len: 32, n: 950 }], 950),
      lifetime: lifetimeStats(tokens), sharing: sharingStats(tokens), association: associationStats(tokens), tokenRowsTruncated: false,
    };
  };

  it("is INCONCLUSIVE when the row cap was reached, whatever else looks good", () => {
    const r = recommend({ ...good(), coverage: assessCoverage({ total_events: 90_000, total_oldest: d("01T00:00:00"), sample_events: 50_000, sample_oldest: d("05T00:00:00"), sample_newest: d("18T00:00:00"), events_with_contact: 50_000, events_with_lead: 50_000 } as CoverageRow, 50_000) });
    assert.equal(r.verdict, "INCONCLUSIVE");
    assert.match(r.reasons.join(" "), /Row cap reached/);
  });

  it("is INCONCLUSIVE for a thin sample, a short range, few multi-event tokens, poor token presence or weak lead linkage", () => {
    const base = good();
    const thin = recommend({ ...base, coverage: cov({ sampleEvents: 40, totalEvents: 40, rangeDays: 2, eventsWithLeadShare: 0.3 }) });
    assert.equal(thin.verdict, "INCONCLUSIVE");
    assert.ok(thin.reasons.length >= 3);
    const missing = recommend({ ...base, presence: summarizePresence([{ field: "cart_token", status: "OK", n: 40 }, { field: "cart_token", status: "MISSING", n: 60 }]) });
    assert.equal(missing.verdict, "INCONCLUSIVE");
    const few = recommend({ ...base, lifetime: lifetimeStats([tv({ n_events: 1 })]) });
    assert.match(few.reasons.join(" "), /too few to observe reuse/);
  });

  it("is INCONCLUSIVE if the token list itself was truncated", () => {
    assert.equal(recommend({ ...good(), tokenRowsTruncated: true }).verdict, "INCONCLUSIVE");
  });

  it("is NOT_RECOMMENDED when a token is shared across leads, formats are mixed, or tokens outlive an order", () => {
    const base = good();
    const shared = [...Array.from({ length: 60 }, (_, i) => tv({ token_fp: `t${i}`, n_leads: 1 })), tv({ token_fp: "shared", n_leads: 2 })];
    assert.equal(recommend({ ...base, sharing: sharingStats(shared) }).verdict, "NOT_RECOMMENDED");
    assert.equal(recommend({ ...base, format: summarizeFormat([{ tok_class: "hex-lower", tok_len: 32, n: 500 }, { tok_class: "alnum", tok_len: 20, n: 450 }], 950) }).verdict, "NOT_RECOMMENDED");
    const outlives = [...Array.from({ length: 60 }, (_, i) => tv({ token_fp: `t${i}`, n_leads: 1 })), tv({ token_fp: "o", n_leads: 1, orders_inside: 1 })];
    assert.equal(recommend({ ...base, association: associationStats(outlives) }).verdict, "NOT_RECOMMENDED");
  });

  it("with full coverage and no disqualifying finding it is at most a CANDIDATE, and says that is not proof", () => {
    const r = recommend(good());
    assert.equal(r.verdict, "CANDIDATE_WITH_GUARDS");
    assert.match(r.reasons.join(" "), /NOT evidence that it is safe/);
    assert.deepEqual(r.limitations, STANDING_LIMITATIONS);
  });
});
