import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertSelectOnly } from "./abandonment-duplicates-report.logic.js";
import {
  ACTIVITIES_SQL, EVENTS_SQL, RECORDS_SQL, analyze, validateRecordIds, type ActivityRow, type EventRow, type RecordRow,
} from "./abandonment-webhook-correlation.logic.js";

const A = "b086bb2f-fa8c-4c31-a8a3-c82b7f778188";
const B = "daa950bb-548b-4814-9431-6286fe6f5dc1";
const at = (s: string) => new Date(`2026-10-18T${s}Z`);

const rec = (id: string, ref_fp: string | null, stage: string, created: string): RecordRow => ({
  id, lead_number: "LEAD-X", status: "ACTIVE", reference_type: "ShiprocketCheckoutCart", stage, ref_fp, detected_at: at(created), created_at: at(created), updated_at: at(created),
});
let n = 0;
const ev = (over: Partial<EventRow>): EventRow => ({
  id: `E${++n}`, delivery_id: "sha256:1234abcd", event_type: "checkout.abandoned", status: "PROCESSED", attempts: 1,
  received_at: at("13:11:35.000"), processed_at: at("13:11:36.500"), next_attempt_at: null, has_error: false,
  ref_key: "cart_id", ref_fp: "28046782", stage: "PAYMENT_INITIATED", payload_updated_at: null, cart_value: "649", item_count: 1, items_fp: "aaaaaaaa",
  fp_cart_id: "28046782", fp_checkout_id: null, fp_session_id: null, fp_id: null, fp_cart_token: null, fp_token: null, phone_match: true, email_match: true, ...over,
});
const recA = rec(A, "28046782", "PAYMENT_INITIATED", "13:11:36.182");
const recB = rec(B, "0b276dc1", "ORDER_SCREEN", "13:21:10.693");
const noActs: ActivityRow[] = [];
const evB = (over: Partial<EventRow> = {}) => ev({ id: "EB", ref_fp: "0b276dc1", fp_cart_id: "0b276dc1", stage: "ORDER_SCREEN", received_at: at("13:21:09.000"), processed_at: at("13:21:10.800"), ...over });

describe("query safety", () => {
  it("all three queries are single SELECT/WITH statements and pass the read-only check", () => {
    for (const sql of [RECORDS_SQL, ACTIVITIES_SQL, EVENTS_SQL]) assert.doesNotThrow(() => assertSelectOnly(sql));
  });

  it("never projects the payload, snapshot, activity description, raw references or customer columns", () => {
    for (const sql of [RECORDS_SQL, ACTIVITIES_SQL, EVENTS_SQL]) {
      assert.equal(/\bw\.payload\s+as\b|\bac\.description\b|\ba\.cart_snapshot\s+as\b|\ba\.reference_id\s+as\b|\bl\.(first_name|last_name|mobile|email)\b/i.test(sql), false);
    }
    assert.equal(/\bdescription\b/.test(ACTIVITIES_SQL), false);
    assert.match(EVENTS_SQL, /encode\(sha256\(convert_to\(/);
    // the delivery id is cut to "sha256:" + 8 hex chars, and the error text is only tested for presence
    assert.match(EVENTS_SQL, /left\(w\.external_event_id, 15\)/);
    assert.equal(/error_message\b(?! is not null)/.test(EVENTS_SQL), false);
  });

  it("is parameterised, provider-scoped and limited", () => {
    assert.match(EVENTS_SQL, /\$1/);
    assert.match(EVENTS_SQL, /\$2::uuid\[\]/);
    assert.match(EVENTS_SQL, /\$3/);
    assert.match(EVENTS_SQL, /limit \$4/);
    assert.match(EVENTS_SQL, /provider = 'SHIPROCKET_CHECKOUT'/);
  });

  it("rejects non-UUID record ids", () => {
    assert.deepEqual(validateRecordIds([A, B.toUpperCase()]), [A, B]);
    for (const bad of [[], ["x"], [A, "1; drop table x"], Array(11).fill(A)]) assert.equal(validateRecordIds(bad as string[]), null);
  });

  it("the runner confirms the host, goes read-only before querying, rolls back and never prints connection details", () => {
    const src = readFileSync(new URL("./abandonment-webhook-correlation.ts", import.meta.url), "utf8");
    assert.match(src, /hostMatches\(target\.host, arg\("expect-host"\)\)/);
    assert.ok(src.indexOf("default_transaction_read_only = on") < src.indexOf("client.query(RECORDS_SQL"));
    assert.match(src, /ROLLBACK/);
    for (const line of src.split("\n").filter((l) => /console\.(log|error|table)/.test(l))) assert.equal(/connectionString|process\.env|payload\b/.test(line), false, line);
  });

  it("an event row has no field that could hold a payload or contact detail", () => {
    for (const k of Object.keys(ev({}))) assert.equal(/payload$|^payload|email$|phone$|name$|address|url/.test(k) && !/_match$/.test(k) && k !== "payload_updated_at", false, k);
  });
});

describe("analysis", () => {
  it("no stored events: inconclusive, by absence of evidence", () => {
    const a = analyze([recA, recB], [], noActs);
    assert.equal(a.conclusion, "INCONCLUSIVE");
    assert.ok(a.caveats.some((c) => /absence of evidence/.test(c)));
  });

  it("events for only one record: inconclusive", () => {
    const a = analyze([recA, recB], [ev({})], noActs);
    assert.equal(a.conclusion, "INCONCLUSIVE");
    assert.equal(a.hypotheses.sameCheckoutProgressing.verdict, "UNDETERMINED");
  });

  it("different chosen references alone do NOT prove separate carts", () => {
    const a = analyze([recA, recB], [ev({}), evB({ items_fp: "bbbbbbbb" })], noActs);
    assert.notEqual(a.conclusion, "SEPARATE_SESSIONS");
    assert.equal(a.hypotheses.separateSessions.verdict, "UNDETERMINED");
    assert.equal(a.hypotheses.repeatedDeliveries.verdict, "NOT_SUPPORTED");
  });

  it("a stable identifier field shared by both references' events supports one checkout (with the constant-field caveat)", () => {
    const a = analyze([recA, recB], [ev({ id: "E1", fp_token: "99999999" }), evB({ ref_key: "id", fp_cart_id: null, fp_id: "0b276dc1", fp_token: "99999999" })], noActs);
    assert.deepEqual(a.sharedStableKeys, ["token"]);
    assert.equal(a.conclusion, "SAME_CHECKOUT_PROGRESSING");
    assert.ok(a.hypotheses.sameCheckoutProgressing.reasons.join(" ").includes("constant"));
    assert.equal(a.hypotheses.separateSessions.verdict, "NOT_SUPPORTED");
  });

  it("interleaved events of two references with no shared field support separate sessions", () => {
    const a = analyze([recA, recB], [
      ev({ id: "E1", received_at: at("13:00:00.000"), processed_at: at("13:00:01.000") }),
      evB({ id: "E2", received_at: at("13:05:00.000"), processed_at: at("13:05:01.000") }),
      ev({ id: "E3" }),
      evB({ id: "E4" }),
    ], noActs);
    assert.equal(a.intervalsInterleave, true);
    assert.equal(a.conclusion, "SEPARATE_SESSIONS");
  });

  it("a shared field together with interleaving events is conflicting, so the result is inconclusive", () => {
    const a = analyze([recA, recB], [
      ev({ id: "E1", fp_token: "77777777", received_at: at("13:00:00.000") }),
      evB({ id: "E2", fp_token: "77777777", received_at: at("13:05:00.000") }),
      ev({ id: "E3", fp_token: "77777777" }),
      evB({ id: "E4", fp_token: "77777777" }),
    ], noActs);
    assert.equal(a.conclusion, "INCONCLUSIVE");
  });

  it("the stage going PAYMENT_INITIATED then ORDER_SCREEN is not read as forward progress", () => {
    const a = analyze([recA, recB], [ev({}), evB()], noActs);
    assert.equal(a.stagesMoveForward, false);
    assert.equal(a.hypotheses.sameCheckoutProgressing.verdict, "UNDETERMINED");
  });

  it("links creation candidates by processed time, and reports unlinked events without pairing them to a record", () => {
    const a = analyze([recA, recB], [ev({ id: "E1" }), ev({ id: "EX", ref_fp: "deadbeef", received_at: at("13:29:59.000"), processed_at: at("13:30:00.000") })], noActs);
    assert.deepEqual(a.recordLinks[0]!.creationCandidateEventIds, ["E1"]);
    assert.deepEqual(a.eventsLinkedToNeither, ["EX"]);
    assert.deepEqual([...a.distinctReferenceFingerprints].sort(), ["28046782", "deadbeef"]);
  });

  it("same reference on both records with two near-simultaneous creators supports repeated deliveries", () => {
    const r1 = rec(A, "28046782", "PAYMENT_INITIATED", "13:11:36.182");
    const r2 = rec(B, "28046782", "PAYMENT_INITIATED", "13:11:36.190");
    const a = analyze([r1, r2], [ev({ id: "E1", processed_at: at("13:11:36.600") }), ev({ id: "E2", delivery_id: "sha256:ffff0000", processed_at: at("13:11:36.700") })], noActs);
    assert.equal(a.hypotheses.repeatedDeliveries.verdict, "SUPPORTED");
  });

  it("surfaces the activity titles written for each record", () => {
    const acts: ActivityRow[] = [{ id: "AC1", abandonment_id: A, created_at: at("13:11:36.200"), title: "Checkout abandoned", source: "SHIPROCKET_WEBHOOK" }];
    assert.deepEqual(analyze([recA, recB], [], acts).recordLinks[0]!.activityTitles.map((x) => x.title), ["Checkout abandoned"]);
  });

  it("every analysis states the evidence limits", () => {
    const c = analyze([recA, recB], [], noActs).caveats.join(" ");
    assert.match(c, /no foreign key/i);
    assert.match(c, /do not prove/i);
  });
});
