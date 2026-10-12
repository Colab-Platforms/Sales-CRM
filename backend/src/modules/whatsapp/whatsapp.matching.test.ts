import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchSenderToLead, type MatchDeps } from "./whatsapp.matching.js";

interface FakeLead {
  id: string;
  normalizedMobile: string | null;
  createdAt: Date;
}

function fakeDb(leads: FakeLead[]): MatchDeps["db"] {
  return {
    lead: {
      async findFirst({ where, orderBy }: any) {
        const wanted: string[] = where.normalizedMobile.in;
        const matches = leads.filter((l) => l.normalizedMobile !== null && wanted.includes(l.normalizedMobile));
        if (matches.length === 0) return null;
        const sorted = orderBy?.createdAt === "asc" ? [...matches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) : matches;
        return { id: sorted[0]!.id };
      },
    } as MatchDeps["db"]["lead"],
  };
}

describe("matchSenderToLead", () => {
  it("matches a lead whose normalizedMobile is stored in the canonical '+' form", async () => {
    const db = fakeDb([{ id: "lead-1", normalizedMobile: "+917840956315", createdAt: new Date("2026-01-01") }]);
    const result = await matchSenderToLead("917840956315", { db });
    assert.equal(result.leadId, "lead-1");
    assert.equal(result.normalizedContact, "+917840956315");
  });

  // Regression: an inbound reply from Komal vini (real customer) was landing in a brand-new,
  // duplicate Inbox conversation instead of her existing one. Root cause: her Lead row's
  // normalizedMobile was stored as "917840956315" (no leading "+"), a pre-existing data artifact
  // predating consistent normalizeMobile() use - so an exact-match lookup against the canonical
  // "+917840956315" the webhook computes missed her lead entirely, and the inbound-message flow's
  // "auto-create a lead for an unmatched sender" behavior created a second, separate lead/conversation.
  it("still matches a lead whose normalizedMobile was stored WITHOUT the leading '+' (legacy data) - the exact bug that split Komal vini's conversation in two", async () => {
    const db = fakeDb([{ id: "lead-komal", normalizedMobile: "917840956315", createdAt: new Date("2026-09-28") }]);
    const result = await matchSenderToLead("+91 78409 56315", { db });
    assert.equal(result.leadId, "lead-komal", "the incoming reply must attach to the existing lead, never create a duplicate");
    assert.equal(result.normalizedContact, "+917840956315");
  });

  // Regression: found live, against the real running server, while verifying the fix above - a bare
  // 10-digit legacy value (country code dropped entirely) is actually the MORE common legacy shape
  // in production (most of the audited legacy leads look like this, e.g. mobile "9000000100" /
  // normalizedMobile "9000000100"), and the first version of this fix (which only tried the
  // "+"-stripped, still-12-digit form) still missed it, still creating a duplicate lead for it.
  it("still matches a lead whose normalizedMobile was stored as a bare 10-digit local number (country code dropped entirely, no '+')", async () => {
    const db = fakeDb([{ id: "lead-bare", normalizedMobile: "9676725103", createdAt: new Date("2026-01-01") }]);
    const result = await matchSenderToLead("+91 96767-25103", { db });
    assert.equal(result.leadId, "lead-bare", "must match the existing lead, never create a duplicate");
    assert.equal(result.normalizedContact, "+919676725103");
  });

  it("still matches a lead whose normalizedMobile was stored as a bare 10-digit number WITH a retained leading trunk '0'", async () => {
    const db = fakeDb([{ id: "lead-trunk-zero", normalizedMobile: "09676725103", createdAt: new Date("2026-01-01") }]);
    const result = await matchSenderToLead("919676725103", { db });
    assert.equal(result.leadId, "lead-trunk-zero");
  });

  it("prefers the earliest-created lead when both a '+'-form and a legacy-form row exist for the same number", async () => {
    const db = fakeDb([
      { id: "lead-legacy-older", normalizedMobile: "917840956315", createdAt: new Date("2026-01-01") },
      { id: "lead-plus-newer", normalizedMobile: "+917840956315", createdAt: new Date("2026-06-01") },
    ]);
    const result = await matchSenderToLead("917840956315", { db });
    assert.equal(result.leadId, "lead-legacy-older");
  });

  it("returns no match (never invents a lead) for a genuinely new number", async () => {
    const db = fakeDb([{ id: "lead-1", normalizedMobile: "+919999999999", createdAt: new Date() }]);
    const result = await matchSenderToLead("+911234567890", { db });
    assert.equal(result.leadId, null);
    assert.equal(result.normalizedContact, "+911234567890");
  });

  it("returns null/null for an unparseable sender number, without querying misleadingly", async () => {
    const db = fakeDb([]);
    const result = await matchSenderToLead("not-a-number", { db });
    assert.deepEqual(result, { leadId: null, normalizedContact: null });
  });
});

describe("matchSenderToLead: thread affinity with duplicate leads", () => {
  const leads: FakeLead[] = [
    { id: "lead-old", normalizedMobile: "+919812377001", createdAt: new Date("2026-09-29") },
    { id: "lead-new", normalizedMobile: "+919812377001", createdAt: new Date("2026-10-08") },
  ];
  const withSent = (sentFrom: string | null): MatchDeps["db"] => ({
    ...fakeDb(leads),
    whatsAppMessage: {
      async findFirst({ where }: any) {
        assert.equal(where.direction, "OUTBOUND");
        assert.ok(where.normalizedContact.in.includes("+919812377001") && where.normalizedContact.in.includes("9812377001"), "looked up with every legacy shape");
        return sentFrom ? { leadId: sentFrom } : null;
      },
    } as unknown as MatchDeps["db"]["whatsAppMessage"],
  });

  it("the lead the CRM last messaged wins over the oldest lead with that number", async () => {
    assert.equal((await matchSenderToLead("919812377001", { db: withSent("lead-new") })).leadId, "lead-new");
  });
  it("no outbound history -> the oldest lead, exactly as before", async () => {
    assert.equal((await matchSenderToLead("919812377001", { db: withSent(null) })).leadId, "lead-old");
  });
});
