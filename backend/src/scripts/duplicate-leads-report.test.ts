import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hostMatches, maskEmailKey, maskGroupKey, maskPhone, parseTarget } from "./duplicate-leads-report.safety.js";

const SECRET = "s3cr3t-hunter2";

describe("parseTarget", () => {
  it("returns only host and database name", () => {
    const t = parseTarget("postgresql://user:pw@ep-abc-pooler.c-4.aws.neon.tech/neondb?sslmode=require");
    assert.deepEqual(t, { ok: true, host: "ep-abc-pooler.c-4.aws.neon.tech", db: "neondb" });
    assert.equal(JSON.stringify(t).includes("pw"), false);
  });

  it("reports a malformed URL as { ok: false } without ever surfacing the input", () => {
    for (const bad of [`postgresql://user:pw-${SECRET}@host:notaport/db`, `not a url ${SECRET}`, `://${SECRET}`, "", undefined]) {
      const t = parseTarget(bad);
      assert.deepEqual(t, { ok: false });
      assert.equal(JSON.stringify(t).includes(SECRET), false);
    }
  });

  it("does not throw on malformed input", () => {
    assert.doesNotThrow(() => parseTarget(`postgres://u:${SECRET}@[bad`));
  });
});

describe("hostMatches (exact hostname)", () => {
  const host = "ep-example-1234.c-4.ap-southeast-1.aws.neon.tech";

  it("accepts the exact host, ignoring case and the pooled/direct difference", () => {
    assert.equal(hostMatches(host, host), true);
    assert.equal(hostMatches(host, host.toUpperCase()), true);
    assert.equal(hostMatches("ep-example-1234-pooler.c-4.ap-southeast-1.aws.neon.tech", host), true);
  });

  it("rejects substrings, prefixes and other hosts", () => {
    for (const partial of ["neon", "ep-example", "aws.neon.tech", "example-1234", host.slice(0, -1), `x${host}`, `${host}.evil.com`]) {
      assert.equal(hostMatches(host, partial), false, partial);
    }
  });

  it("rejects a missing or blank expectation", () => {
    assert.equal(hostMatches(host, undefined), false);
    assert.equal(hostMatches(host, ""), false);
    assert.equal(hostMatches(host, "   "), false);
  });
});

describe("masking", () => {
  it("keeps only the last four digits of a phone number", () => {
    assert.equal(maskPhone("+919876543210"), "+********3210");
    assert.equal(maskPhone("9876543210"), "******3210");
    assert.equal(maskPhone("+919876543210").includes("98765"), false);
  });

  it("never reveals short numbers", () => {
    assert.equal(maskPhone("1234"), "****");
    assert.equal(maskPhone("12"), "**");
  });

  it("masks group keys for phones and emails", () => {
    assert.equal(maskGroupKey("phone:+919876543210"), "phone:+********3210");
    assert.equal(maskGroupKey("email:ram.sharma@example.com"), "email:r***@example.com");
    assert.equal(maskEmailKey("email:a@b.com"), "email:a***@b.com");
  });
});

describe("report script safety (static checks on the source)", () => {
  const source = readFileSync(new URL("./duplicate-leads-report.ts", import.meta.url), "utf8");
  const queries = [...source.matchAll(/client\.query\(\s*[`"]([\s\S]*?)[`"]\s*\)/g)].map((m) => m[1]!.trim());

  it("issues only SELECTs, plus the session read-only setting", () => {
    assert.ok(queries.length >= 4);
    for (const q of queries) {
      assert.ok(/^select\b/i.test(q) || q === "SET default_transaction_read_only = on", `unexpected statement: ${q.slice(0, 40)}`);
    }
    assert.ok(queries.includes("SET default_transaction_read_only = on"));
  });

  it("contains no write statements or raw write APIs", () => {
    assert.equal(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s|alter\s|truncate\s|create\s+(table|index))/i.test(queries.join("\n")), false);
    assert.equal(/\$executeRaw|\.(create|update|delete|upsert)\(/.test(source), false);
  });

  it("sets the session read-only before running any report query", () => {
    const readOnlyAt = source.indexOf("SET default_transaction_read_only = on");
    const firstSelectAt = source.indexOf("select l.id");
    assert.ok(readOnlyAt > 0 && readOnlyAt < firstSelectAt);
  });

  it("prefers REPORT_DATABASE_URL and refuses to run before connecting unless the host matches", () => {
    assert.ok(source.indexOf("process.env.REPORT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL") > 0);
    assert.ok(source.includes("hostMatches(target.host, expectHost)"));
    assert.ok(source.indexOf("hostMatches(") < source.indexOf("client.connect()"));
  });

  it("never logs the connection string or the full phone number", () => {
    // No console call may reference the URL variable, and phones must only ever be printed via maskPhone.
    const consoleCalls = source.split("\n").filter((line) => /console\.(log|error|table)/.test(line));
    assert.equal(consoleCalls.some((line) => /connectionString|REPORT_DATABASE_URL/.test(line)), false);
    assert.equal(source.includes("stored_mobile: r.normalized_mobile,"), false);
    assert.ok((source.match(/maskPhone\(/g) ?? []).length >= 2);
  });
});

describe("a password with an unescaped '@' cannot silently retarget a different database", () => {
  it("parses to the wrong host, which the exact --expect-host check then refuses", () => {
    const t = parseTarget(`postgresql://user:s3cr3t-P@ss/word#1@ep-real.neon.tech/neondb`);
    assert.equal(t.ok && hostMatches(t.host, "ep-real.neon.tech"), false);
  });
});

describe("maskName", () => {
  it("keeps only the first character of a customer name", async () => {
    const { maskName } = await import("./duplicate-leads-report.safety.js");
    assert.equal(maskName("Komal"), "K***");
    assert.equal(maskName("  ram sharma "), "r***");
    assert.equal(maskName(""), null);
    assert.equal(maskName(null), null);
  });
});
