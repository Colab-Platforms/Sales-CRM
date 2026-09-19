import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, normalizeMobile } from "./leadIdentity.js";

describe("normalizeMobile", () => {
  it("gives the same result however an Indian number is written", () => {
    for (const raw of ["9811122334", "+91 98111 22334", "+919811122334", "91-9811122334", "09811122334", "0091 98111 22334", "(+91) 98111-22334"]) {
      assert.equal(normalizeMobile(raw), "+919811122334", raw);
    }
  });

  it("keeps numbers from other countries as given", () => {
    assert.equal(normalizeMobile("+1 (415) 555-2671"), "+14155552671");
    assert.equal(normalizeMobile("+44 7911 123456"), "+447911123456");
  });

  it("rejects anything that is not plausibly a phone number", () => {
    for (const raw of [null, undefined, "", "   ", "abc", "123", "0000000000", "+", "1".repeat(20)]) {
      assert.equal(normalizeMobile(raw as string | null | undefined), null, String(raw));
    }
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    assert.equal(normalizeEmail("  Asha.Verma@Example.COM "), "asha.verma@example.com");
  });

  it("rejects things that are not emails", () => {
    for (const raw of [null, undefined, "", "not-an-email", "a@b", "a b@c.com", "@c.com"]) {
      assert.equal(normalizeEmail(raw as string | null | undefined), null, String(raw));
    }
  });
});
