// Run with: ../backend/node_modules/.bin/tsx --test lib/call-recordings.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toFilterParams, type CallRecordingFilterState } from "./api-client/endpoints/call-recordings.api";
import { callRecordingsHref } from "./call-recordings-href";

const base: CallRecordingFilterState = { from: "2026-11-01", to: "2026-11-25", telecallerIds: [], customer: "", mobile: "", items: [], statuses: [], outcomes: [], leadType: "all", sort: "latest" };

describe("call recordings filters -> API params", () => {
  it("sends only what is set (the date range and sort order always)", () => {
    assert.deepEqual(toFilterParams(base), { from: "2026-11-01", to: "2026-11-25", sort: "latest" });
  });

  it("sends every filter so they all apply together", () => {
    const p = toFilterParams({ ...base, telecallerIds: ["a", "b"], customer: " Rahul ", mobile: "98765", items: ["s:SKU1|Sleep Gummies"], statuses: ["INTERESTED"], outcomes: ["status:NO_ANSWER"], minDuration: 60, maxDuration: 180, leadId: "L", leadType: "regular", sort: "oldest" });
    assert.equal(p.telecallerIds, "a,b");
    assert.equal(p.customer, "Rahul");
    assert.equal(p.items, encodeURIComponent("s:SKU1|Sleep Gummies"));
    assert.equal(p.statuses, "INTERESTED");
    assert.equal(p.outcomes, "status:NO_ANSWER");
    assert.equal(p.minDuration, "60");
    assert.equal(p.maxDuration, "180");
    assert.equal(p.leadId, "L");
    assert.equal(p.leadType, "regular");
    assert.equal(p.sort, "oldest");
  });
});

describe("View Recordings link", () => {
  it("opens the Call Recordings page for that lead across the whole history", () => {
    const href = callRecordingsHref("11111111-1111-4111-8111-111111111111");
    assert.match(href, /^\/dashboard\/abandoned-leads\/call-recordings\?/);
    assert.match(href, /leadId=11111111-1111-4111-8111-111111111111/);
    assert.match(href, /from=2020-01-01/);
  });
});
