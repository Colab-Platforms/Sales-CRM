import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMigrationUrl } from "./migrationUrl.js";

const POOLED = "postgresql://u:p@ep-abc-123-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const DIRECT = "postgresql://u:p@ep-abc-123.eu-central-1.aws.neon.tech/neondb?sslmode=require";

describe("migration URL for the Prisma CLI", () => {
  it("without DIRECT_URL (unset or blank) nothing changes: DATABASE_URL is used, and a pooled host is flagged", () => {
    assert.deepEqual(resolveMigrationUrl({ DATABASE_URL: POOLED }), { url: POOLED, source: "DATABASE_URL", pooled: true });
    assert.deepEqual(resolveMigrationUrl({ DATABASE_URL: DIRECT, DIRECT_URL: "   " }), { url: DIRECT, source: "DATABASE_URL", pooled: false });
    assert.deepEqual(resolveMigrationUrl({}), { url: undefined, source: "none", pooled: false });
  });

  it("DIRECT_URL wins when it is the non-pooled form of the same database", () => {
    assert.deepEqual(resolveMigrationUrl({ DATABASE_URL: POOLED, DIRECT_URL: DIRECT }), { url: DIRECT, source: "DIRECT_URL", pooled: false });
    assert.equal(resolveMigrationUrl({ DIRECT_URL: DIRECT }).source, "DIRECT_URL", "usable even when DATABASE_URL is absent");
  });

  it("refuses a DIRECT_URL for a different server, database or port - a leftover value can never redirect a run that targets another database - and never echoes the URLs", () => {
    const isolated = "postgresql://postgres@127.0.0.1:5544/crm_iso";
    for (const env of [
      { DATABASE_URL: isolated, DIRECT_URL: DIRECT },
      { DATABASE_URL: POOLED, DIRECT_URL: DIRECT.replace("/neondb", "/otherdb") },
      { DATABASE_URL: POOLED, DIRECT_URL: DIRECT.replace("ep-abc-123.", "ep-zzz-999.") },
    ]) {
      assert.throws(() => resolveMigrationUrl(env), (e: Error) => /different servers or databases/.test(e.message) && !/neon\.tech|127\.0\.0\.1|u:p/.test(e.message));
    }
    assert.throws(() => resolveMigrationUrl({ DIRECT_URL: "not a url" }), (e: Error) => /not a valid connection URL/.test(e.message) && !e.message.includes("not a url"));
  });

  it("a DIRECT_URL that is itself a pooler host is flagged so the CLI can warn", () => {
    assert.equal(resolveMigrationUrl({ DATABASE_URL: POOLED, DIRECT_URL: POOLED }).pooled, true);
  });
});
