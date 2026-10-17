import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assertSelectOnly,
  buildMergePlan,
  formatPlan,
  LEAD_REFERENCES,
  maskEmail,
  refKey,
  totalLinked,
  type LeadEvidence,
  type Overlaps,
} from "./duplicate-lead-merge-plan.js";

const none: Overlaps = { communicationChannels: [], campaignIds: [] };

function lead(over: Partial<LeadEvidence> & { leadNumber: string }): LeadEvidence {
  return {
    id: `id-${over.leadNumber}`, firstName: "Asha", lastName: "Rao", normalizedMobile: "+919876543210", normalizedEmail: null,
    source: null, owner: null, assignedManager: null, group: null, createdAt: new Date("2026-09-30T01:00:00Z"),
    lastActivityAt: null, lastContactedAt: null, workingStatus: "NEW", lifecycleStage: "LEAD", externalSource: null, externalId: null,
    counts: {}, softReferenceCount: 0, latestCallAt: null, latestActivityAt: null, ...over,
  };
}
const withCounts = (c: Record<string, number>) => ({ counts: Object.fromEntries(Object.entries(c).map(([t, n]) => [`${t}.lead_id`, n])) });

describe("LEAD_REFERENCES covers every foreign key to leads in the Prisma schema", () => {
  const dir = new URL("../../prisma/schema/", import.meta.url);
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".prisma"))) {
    const src = readFileSync(new URL(file, dir), "utf8");
    for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const body = m[2]!;
      const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? m[1]!;
      for (const line of body.split("\n")) {
        const r = line.match(/^\s*\w+\s+Lead\??\s+@relation\((?:"[^"]*",\s*)?fields:\s*\[(\w+)\]/);
        if (!r) continue;
        const columnLine = body.split("\n").find((l) => new RegExp(`^\\s*${r[1]}\\s`).test(l)) ?? "";
        found.push(`${table}.${columnLine.match(/@map\("([^"]+)"\)/)?.[1] ?? r[1]}`);
      }
    }
  }

  it("lists exactly the tables the schema says reference a lead (a new foreign key must be added here)", () => {
    assert.ok(found.length >= 14);
    assert.deepEqual(LEAD_REFERENCES.map(refKey).sort(), [...found].sort());
  });
});

describe("buildMergePlan", () => {
  const A = lead({ leadNumber: "LEAD-A", firstName: "Vishwaa", lastName: "L", owner: { name: "Seed Salesperson", status: "ACTIVE" }, createdAt: new Date("2026-09-30T01:11:00Z"), ...withCounts({ calls: 8, activities: 1 }) });
  const B = lead({ leadNumber: "LEAD-B", firstName: "komal", lastName: "vini", owner: { name: "E3 UAT Salesperson", status: "ACTIVE" }, createdAt: new Date("2026-09-30T01:18:00Z"), ...withCounts({ calls: 4, activities: 1 }) });

  it("produces one option per direction, listing exactly the rows to re-point", () => {
    const plan = buildMergePlan(A, B, none);
    assert.equal(plan.options.length, 2);
    const keepA = plan.options.find((o) => o.survivor === "LEAD-A")!;
    assert.deepEqual(keepA.repoints.map((r) => [r.table, r.rows]), [["calls", 4], ["activities", 1]]);
    const keepB = plan.options.find((o) => o.survivor === "LEAD-B")!;
    assert.deepEqual(keepB.repoints.map((r) => [r.table, r.rows]), [["calls", 8], ["activities", 1]]);
  });

  it("never names a recommended survivor - the older lead is not assumed to be right", () => {
    const plan = buildMergePlan(A, B, none);
    assert.equal(Object.keys(plan).sort().join(","), "evidence,options,warnings");
    const text = formatPlan(A, B, plan).join("\n");
    assert.equal(/recommend(ed)?:|\bsurvivor is\b.*\bLEAD-/i.test(text), false);
    assert.ok(text.includes("a human decision"));
    // the older lead (A) is "created first" only as one fact among the others; B is not penalised for being newer
    assert.ok(plan.evidence["LEAD-A"]!.includes("created first"));
    assert.ok(!plan.evidence["LEAD-B"]!.includes("created first"));
  });

  it("warns when names or owners differ, since a shared number does not prove one person", () => {
    const w = buildMergePlan(A, B, none).warnings.join("\n");
    assert.match(w, /Names differ/);
    assert.match(w, /Different owners/);
  });

  it("does not warn about names when they match", () => {
    const same = buildMergePlan(lead({ leadNumber: "X" }), lead({ leadNumber: "Y" }), none).warnings.join("\n");
    assert.equal(/Names differ/.test(same), false);
  });

  it("warns when the phone numbers are not actually the same", () => {
    const w = buildMergePlan(A, lead({ leadNumber: "Z", normalizedMobile: "+919000000001" }), none).warnings.join("\n");
    assert.match(w, /phone numbers differ/);
  });

  it("treats the same number stored in different shapes as the same", () => {
    const w = buildMergePlan(lead({ leadNumber: "X", normalizedMobile: "9876543210" }), lead({ leadNumber: "Y", normalizedMobile: "+919876543210" }), none).warnings.join("\n");
    assert.equal(/phone numbers differ/.test(w), false);
  });

  it("warns when the two leads belong to different external customers", () => {
    const w = buildMergePlan(lead({ leadNumber: "X", externalSource: "SHOPIFY", externalId: "1" }), lead({ leadNumber: "Y", externalSource: "SHOPIFY", externalId: "2" }), none).warnings.join("\n");
    assert.match(w, /different external customer ids/);
  });

  it("flags uniqueness blockers: one WhatsApp conversation per lead, shared channels and campaigns", () => {
    const x = lead({ leadNumber: "X", ...withCounts({ whatsapp_conversations: 1, communication_preferences: 2, whatsapp_campaign_recipients: 1 }) });
    const y = lead({ leadNumber: "Y", ...withCounts({ whatsapp_conversations: 1, communication_preferences: 1, whatsapp_campaign_recipients: 1 }) });
    const plan = buildMergePlan(x, y, { communicationChannels: ["WHATSAPP"], campaignIds: ["c1"] });
    const blockers = plan.options[0]!.blockers.join("\n");
    assert.match(blockers, /whatsapp_conversations: each lead may have only one row/);
    assert.match(blockers, /communication_preferences: .*WHATSAPP/);
    assert.match(blockers, /whatsapp_campaign_recipients: .*1 campaign/);
  });

  it("has no blockers when there is no overlap", () => {
    assert.deepEqual(buildMergePlan(A, B, none).options.flatMap((o) => o.blockers), []);
  });

  it("includes soft (reference_id) activity references in the plan", () => {
    const plan = buildMergePlan(lead({ leadNumber: "X" }), lead({ leadNumber: "Y", softReferenceCount: 3 }), none);
    assert.ok(plan.options.find((o) => o.survivor === "X")!.repoints.some((r) => r.column === "reference_id" && r.rows === 3));
    assert.match(plan.warnings.join("\n"), /3 activity row/);
  });

  it("totals linked records across every referencing table", () => {
    assert.equal(totalLinked(A), 9);
    assert.equal(LEAD_REFERENCES.length, 14);
  });
});

describe("output masking", () => {
  const A = lead({ leadNumber: "LEAD-A", normalizedMobile: "+919876543210", normalizedEmail: "ram.sharma@example.com" });
  const B = lead({ leadNumber: "LEAD-B", normalizedMobile: "+919876543210", normalizedEmail: "ram.sharma@example.com" });
  const text = formatPlan(A, B, buildMergePlan(A, B, none)).join("\n");

  it("never prints a full phone number or email", () => {
    assert.equal(text.includes("9876543210"), false);
    assert.equal(text.includes("98765"), false);
    assert.equal(text.includes("ram.sharma"), false);
    assert.ok(text.includes("3210"));
    assert.ok(text.includes("r***@example.com"));
  });

  it("masks emails", () => {
    assert.equal(maskEmail("a@b.com"), "a***@b.com");
    assert.equal(maskEmail(null), null);
    assert.equal(maskEmail("nodomain"), "***");
  });

  it("states plainly that it is a dry run", () => {
    assert.match(text, /^DRY RUN - nothing was changed/);
  });
});

describe("assertSelectOnly - the dry-run cannot send a write", () => {
  it("accepts plain selects", () => {
    for (const ok of ["select 1", "  SELECT count(*) as n from calls where lead_id = $1", "select a from t where reference_type = 'Lead';"]) {
      assert.doesNotThrow(() => assertSelectOnly(ok), ok);
    }
  });

  it("rejects every kind of write and anything that is not a single select", () => {
    for (const bad of [
      "update leads set owner_id = null",
      "delete from leads",
      "insert into leads values (1)",
      "drop table leads",
      "alter table leads add column x int",
      "truncate leads",
      "create table x (a int)",
      "select 1; delete from leads",
      "select 1; select 2",
      "with x as (delete from leads returning *) select * from x",
      "select * from leads for update",
      "select pg_advisory_lock(1); lock table leads",
      "copy leads to stdout",
      "call do_something()",
      "SET default_transaction_read_only = off",
      "begin",
    ]) {
      assert.throws(() => assertSelectOnly(bad), /dry-run refused/, bad);
    }
  });

  it("is not fooled by a write keyword inside a string literal", () => {
    assert.doesNotThrow(() => assertSelectOnly("select * from activities where title = 'delete from x'"));
  });
});

describe("dry-run script (static checks on the source)", () => {
  const source = readFileSync(new URL("./duplicate-lead-merge-dryrun.ts", import.meta.url), "utf8");

  it("sends data queries only through the select() wrapper, which asserts SELECT-only first", () => {
    assert.match(source, /async function select\([^)]*\)[^{]*\{\s*assertSelectOnly\(sql\);/);
    const directCalls = [...source.matchAll(/client\.query\(([^\n]*)/g)].map((m) => m[1]!);
    // exactly two direct uses: the session read-only setting, and the body of select() itself
    assert.equal(directCalls.length, 2);
    assert.ok(directCalls.some((c) => c.includes("SET default_transaction_read_only = on")));
    assert.ok(directCalls.some((c) => c.includes("sql, params")));
  });

  it("every SQL string it builds passes assertSelectOnly", () => {
    const sqls = [...source.matchAll(/select\(\s*`([\s\S]*?)`/g)].map((m) => m[1]!.replace(/\$\{[^}]+\}/g, "calls"));
    assert.equal(sqls.length, 7);
    for (const sql of sqls) assert.doesNotThrow(() => assertSelectOnly(sql), sql.slice(0, 50));
  });

  it("sets the session read-only before the first query and confirms the host before connecting", () => {
    assert.ok(source.indexOf("SET default_transaction_read_only = on") < source.indexOf("await loadLead("));
    assert.ok(source.indexOf("hostMatches(target.host, expectHost)") < source.indexOf("client.connect()"));
  });

  it("contains no write API or write SQL anywhere in the script", () => {
    assert.equal(/\$executeRaw|\.(create|update|delete|upsert)\(|\b(insert\s+into|delete\s+from|update\s+\w+\s+set|drop\s+table|truncate\s)/i.test(source), false);
  });

  it("handles exactly one candidate pair and never prints the connection string", () => {
    assert.match(source, /leadNumbers\.length !== 2/);
    const consoleLines = source.split("\n").filter((l) => /console\.(log|error)/.test(l));
    assert.equal(consoleLines.some((l) => /connectionString|REPORT_DATABASE_URL/.test(l)), false);
  });

  it("table and column names come from the constant list, ids from parameters", () => {
    assert.match(source, /count\(\*\) as n from \$\{ref\.table\} where \$\{ref\.column\} = \$1`, \[l\.id\]/);
  });
});
