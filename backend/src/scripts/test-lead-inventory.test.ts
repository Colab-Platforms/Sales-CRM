import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertSelectOnly } from "./duplicate-lead-merge-plan.js";

const source = readFileSync(new URL("./test-lead-inventory.ts", import.meta.url), "utf8");

describe("test-lead inventory script (static safety checks)", () => {
  it("reads only through select(), which asserts SELECT-only before sending", () => {
    assert.match(source, /async function select\([^)]*\)[^{]*\{\s*assertSelectOnly\(sql\);/);
    const directCalls = [...source.matchAll(/client\.query\(([^\n]*)/g)].map((m) => m[1]!);
    assert.equal(directCalls.length, 2);
    assert.ok(directCalls.some((c) => c.includes("SET default_transaction_read_only = on")));
    assert.ok(directCalls.some((c) => c.includes("sql, params")));
  });

  it("every SQL string it builds passes assertSelectOnly", () => {
    const sqls = [...source.matchAll(/select\(\s*`([\s\S]*?)`/g)].map((m) => m[1]!.replace(/\$\{[^}]+\}/g, "calls"));
    assert.equal(sqls.length, 6);
    for (const sql of sqls) assert.doesNotThrow(() => assertSelectOnly(sql), sql.slice(0, 50));
  });

  it("sets the session read-only before the first query and confirms the exact host before connecting", () => {
    assert.ok(source.indexOf("SET default_transaction_read_only = on") < source.indexOf("for (const leadNumber of leadNumbers)"));
    assert.ok(source.indexOf("hostMatches(target.host, expectHost)") < source.indexOf("client.connect()"));
  });

  it("contains no write API or write SQL", () => {
    assert.equal(/\$executeRaw|\.(create|update|delete|upsert)\(|\b(insert\s+into|delete\s+from|update\s+\w+\s+set|drop\s+table|truncate\s)/i.test(source), false);
  });

  it("never prints the connection string, a full phone number, or any email", () => {
    const consoleLines = source.split("\n").filter((l) => /console\.(log|error|table)/.test(l));
    assert.equal(consoleLines.some((l) => /connectionString|REPORT_DATABASE_URL/.test(l)), false);
    assert.equal(/\bemail\b/i.test(source.replace(/^\/\/.*$/gm, "")), false);
    assert.equal(source.includes("phone: lead.normalized_mobile,"), false);
    assert.equal(source.includes("customer: c.customer_number,"), false);
    assert.ok((source.match(/maskPhone\(/g) ?? []).length >= 2);
  });

  it("is limited to a handful of explicitly named leads", () => {
    assert.match(source, /leadNumbers\.length > 5/);
  });

  it("inventories every table that references a lead, plus calls with recording/transcript ids, activities and webhook events", () => {
    for (const needle of ["LEAD_REFERENCES", "call_recordings", "call_transcripts", "from activities", "webhook_events"]) assert.ok(source.includes(needle), needle);
  });
});

describe("test-lead inventory script - output and error masking", () => {
  it("masks the customer's name in the output (including --json), and never selects an email", () => {
    assert.ok(source.includes("firstName: maskName(lead.first_name)"));
    assert.equal(source.includes("firstName: lead.first_name"), false);
  });

  it("a failing query prints only a generic line plus the SQLSTATE code, never the database's message", () => {
    const body = source.slice(source.indexOf("async function select("), source.indexOf("const inventory"));
    assert.match(body, /catch \(error\)/);
    assert.equal(/error\.message|String\(error\)|\$\{error\}/.test(body), false);
    assert.match(body, /process\.exit\(2\)/);
  });

  it("writes its status messages to stderr so a redirected --json file contains only the inventory", () => {
    const stdoutLines = source.split("\n").filter((l) => /console\.log/.test(l));
    assert.equal(stdoutLines.some((l) => /Target database|Refusing/.test(l)), false);
  });
});
