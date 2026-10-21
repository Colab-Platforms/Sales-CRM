import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BROAD_OPEN_SQL, LEAD_RECORDS_SQL, READ_ONLY_SETUP, assertSelectOnly, fingerprint, groupOpen, maskReference, patternsForLead, summarizeBroad, summarizeLead,
  timingNote, toView, validateLeadNumber, type RawRow,
} from "./abandonment-duplicates-report.logic.js";

let n = 0;
const row = (over: Partial<RawRow> = {}): RawRow => ({
  id: `A${++n}`, lead_id: "L1", lead_number: "LEAD-TEST-0001", type: "CHECKOUT", status: "ACTIVE", reference_type: "ShiprocketCheckoutCart",
  reference_id: "cart-token-abcdef123456", stage: "ORDER_SCREEN", cart_value: "649",
  detected_at: new Date("2026-10-19T00:00:00Z"), created_at: new Date("2026-10-19T00:00:01Z"), updated_at: new Date("2026-10-19T00:00:01Z"), recovered_at: null,
  activity_count: "1", recovery_action_count: "0", ...over,
});

describe("query safety", () => {
  it("both report queries are single SELECTs, parameterised, and never select cart_snapshot wholesale or customer columns", () => {
    for (const sql of [LEAD_RECORDS_SQL, BROAD_OPEN_SQL]) {
      assert.doesNotThrow(() => assertSelectOnly(sql));
      assert.match(sql, /\$1/);
      assert.equal(/\bl\.(mobile|email|first_name|last_name|normalized_)/.test(sql), false);
      assert.equal(/select\s+a\.cart_snapshot\b|payload/i.test(sql), false);
    }
  });

  it("rejects writes, DDL, session changes and multiple statements", () => {
    for (const bad of [
      "update abandonments set status = 'EXPIRED'", "delete from abandonments", "insert into abandonments values (1)", "drop table abandonments",
      "select 1; delete from abandonments", "with x as (delete from abandonments returning *) select * from x", "select * from abandonments for update",
      "truncate abandonments", "set default_transaction_read_only = off", "copy abandonments to stdout", "", "  -- select\n delete from leads",
    ]) assert.throws(() => assertSelectOnly(bad), Error, bad);
  });

  it("is not fooled by keywords inside string literals or column names", () => {
    assert.doesNotThrow(() => assertSelectOnly("select updated_at, 'delete' as word from abandonments where status = 'ACTIVE'"));
  });

  it("the session is made read-only before any query", () => {
    assert.equal(READ_ONLY_SETUP[0], "BEGIN READ ONLY");
  });

  it("the script confirms the host, sets read-only before querying, rolls back, and never prints the connection string", () => {
    const src = readFileSync(new URL("./abandonment-duplicates-report.ts", import.meta.url), "utf8");
    assert.match(src, /hostMatches\(target\.host, arg\("expect-host"\)\)/);
    assert.ok(src.indexOf("default_transaction_read_only = on") < src.indexOf("assertSelectOnly(LEAD_RECORDS_SQL)"));
    assert.match(src, /ROLLBACK/);
    for (const line of src.split("\n").filter((l) => /console\.(log|error)/.test(l))) assert.equal(/connectionString|process\.env/.test(line), false, line);
    assert.equal(/\b(insert|update|delete)\s+(into|from|\w+\s+set)\b/i.test(src.replace(/\/\/.*$/gm, "")), false);
  });

  it("validates the lead number", () => {
    assert.equal(validateLeadNumber(" LEAD-MVE696WA-84P1 "), "LEAD-MVE696WA-84P1");
    for (const bad of ["", undefined, "x'; drop table leads;--", "a b", "x".repeat(51)]) assert.equal(validateLeadNumber(bad), null);
  });
});

describe("masking", () => {
  it("never prints a full cart reference, only edges, length and a fingerprint", () => {
    const ref = "cart-token-abcdef123456";
    const m = maskReference(ref);
    assert.equal(m.includes(ref), false);
    assert.equal(m.includes("abcdef"), false);
    assert.match(m, new RegExp(`fp ${fingerprint(ref)}`));
    assert.equal(maskReference(null), "(null)");
    assert.equal(maskReference("tiny").includes("tiny"), false);
  });

  it("the record view exposes no customer fields and distinct references get distinct fingerprints", () => {
    const v = toView(row());
    assert.deepEqual(Object.keys(v).sort(), ["activities", "cartValue", "createdAt", "detectedAt", "id", "leadId", "leadNumber", "recoveredAt", "recoveryActions", "reference", "referenceFp", "stage", "status", "updatedAt"].sort());
    assert.notEqual(toView(row({ reference_id: "other-cart-999999" })).referenceFp, v.referenceFp);
    assert.equal(toView(row({ reference_id: null })).referenceFp, null);
  });
});

describe("grouping", () => {
  it("groups open records by lead + reference + stage and reports repeats", () => {
    const rows = [row(), row(), row({ stage: "PAYMENT" }), row({ reference_id: "second-cart-token-99" })];
    const groups = groupOpen(rows);
    assert.equal(groups.length, 3);
    assert.equal(groups.find((g) => g.count === 2)?.stage, "ORDER_SCREEN");
  });

  it("ignores closed records and never merges across leads", () => {
    const groups = groupOpen([row(), row({ status: "RECOVERED" }), row({ lead_id: "L2", lead_number: "LEAD-TEST-0002" })]);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((g) => g.count === 1));
  });

  it("null references group together, separately from non-null ones", () => {
    const groups = groupOpen([row({ reference_id: null }), row({ reference_id: null }), row()]);
    assert.deepEqual(groups.map((g) => g.count).sort(), [1, 2]);
  });

  it("labels patterns without claiming a cause", () => {
    assert.deepEqual(patternsForLead([row(), row()]), ["SAME_REFERENCE_AND_STAGE"]);
    assert.deepEqual(patternsForLead([row(), row({ stage: "PAYMENT" })]), ["SAME_REFERENCE_DIFF_STAGE"]);
    assert.ok(patternsForLead([row({ reference_id: null }), row({ reference_id: null })]).includes("NULL_REFERENCE"));
    assert.deepEqual(patternsForLead([row(), row({ reference_id: "another-cart-token-1" })]), ["DIFFERENT_REFERENCES"]);
    assert.deepEqual(patternsForLead([row()]), []);
  });

  it("different references alone are not reported as a repeated group", () => {
    const s = summarizeLead([row(), row({ reference_id: "another-cart-token-1" })])!;
    assert.equal(s.repeatedGroups.length, 0);
    assert.deepEqual(s.patterns, ["DIFFERENT_REFERENCES"]);
  });

  it("computes the creation span, and timing wording never asserts a race", () => {
    const a = row({ created_at: new Date("2026-10-19T00:00:00.000Z") });
    const b = row({ created_at: new Date("2026-10-19T00:00:00.120Z") });
    assert.equal(groupOpen([a, b])[0]!.createdSpanMs, 120);
    for (const ms of [120, 30_000, 7_200_000]) assert.equal(/\bis a race\b|caused by/i.test(timingNote(ms)), false);
    assert.match(timingNote(120), /not proof/);
  });

  it("summarizes the broad scan per lead and counts all statuses for the target lead", () => {
    const s = summarizeBroad([row(), row(), row({ lead_id: "L2", lead_number: "LEAD-TEST-0002" }), row({ lead_id: "L2", lead_number: "LEAD-TEST-0002", reference_id: "zzzzzzzzzzzz" })]);
    assert.equal(s.length, 2);
    const one = summarizeLead([row(), row({ status: "RECOVERED" })])!;
    assert.equal(one.totalCheckoutRecords, 2);
    assert.equal(one.openRecords, 1);
    assert.equal(summarizeLead([]), null);
  });
});
