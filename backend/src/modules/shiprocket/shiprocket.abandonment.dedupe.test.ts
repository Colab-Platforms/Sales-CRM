import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findExistingLead, findOpenAbandonment, lockContact } from "./shiprocket.abandonment.processor.js";

// In-memory stand-in for the few Prisma calls the processor's dedupe helpers make. It evaluates the
// real `where` the helpers build, so a wrong query shape fails here rather than only in production.
interface FakeLead { id: string; normalizedMobile: string | null; normalizedEmail: string | null; createdAt: number; workingStatus?: string }
interface FakeAbandonment { id: string; leadId: string; type: string; referenceId: string | null; status: string; createdAt: number }

function makeTx(leads: FakeLead[], abandonments: FakeAbandonment[] = []) {
  const locks: string[] = [];
  const tx = {
    lead: {
      async findFirst({ where, orderBy }: any) {
        const matches = leads.filter((l) => (where.workingStatus?.not === undefined || (l.workingStatus ?? "NEW") !== where.workingStatus.not) &&
          where.OR.some((c: any) =>
            c.normalizedMobile ? c.normalizedMobile.in.includes(l.normalizedMobile) : c.normalizedEmail ? c.normalizedEmail === l.normalizedEmail : false,
          ),
        );
        if (orderBy?.createdAt === "asc") matches.sort((a, b) => a.createdAt - b.createdAt);
        return matches[0] ? { id: matches[0].id } : null;
      },
    },
    abandonment: {
      async findFirst({ where }: any) {
        const row = abandonments.find(
          (a) => a.leadId === where.leadId && a.type === where.type && a.referenceId === where.referenceId && where.status.in.includes(a.status),
        );
        return row ? { id: row.id } : null;
      },
    },
    async $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      locks.push(String(values[0]));
      return 1;
    },
  };
  return { tx: tx as never, locks };
}

const lead = (id: string, normalizedMobile: string | null, createdAt = 1, normalizedEmail: string | null = null, workingStatus = "NEW"): FakeLead => ({ id, normalizedMobile, normalizedEmail, createdAt, workingStatus });

describe("abandonment lead matching (phone normalization)", () => {
  const FORMATS = ["+91 98765 43210", "919876543210", "09876543210", "9876543210", "+91-9876543210", "0091 9876543210"];

  for (const stored of ["+919876543210", "919876543210", "9876543210", "09876543210"]) {
    it(`finds a lead stored as "${stored}" from every way the number can be sent`, async () => {
      const { tx } = makeTx([lead("L1", stored)]);
      for (const sent of FORMATS) {
        assert.equal((await findExistingLead(tx, { phone: sent, email: null }))?.id, "L1", `sent as ${sent}`);
      }
    });
  }

  it("never matches a different customer's number", async () => {
    const { tx } = makeTx([lead("L1", "+919876543210")]);
    assert.equal(await findExistingLead(tx, { phone: "9876543211", email: null }), null);
    assert.equal(await findExistingLead(tx, { phone: "+14155552671", email: null }), null);
  });

  it("matches on email when there is no phone, case-insensitively", async () => {
    const { tx } = makeTx([lead("L1", null, 1, "a@b.com")]);
    assert.equal((await findExistingLead(tx, { phone: null, email: "  A@B.com " }))?.id, "L1");
  });

  it("with no usable contact detail finds nothing", async () => {
    const { tx } = makeTx([lead("L1", "+919876543210")]);
    assert.equal(await findExistingLead(tx, { phone: "123", email: "not-an-email" }), null);
  });

  it("when duplicates already exist, always picks the oldest lead (stable across deliveries)", async () => {
    const { tx } = makeTx([lead("NEW", "9876543210", 20), lead("OLD", "+919876543210", 10)]);
    assert.equal((await findExistingLead(tx, { phone: "9876543210", email: null }))?.id, "OLD");
    assert.equal((await findExistingLead(tx, { phone: "9876543210", email: null }))?.id, "OLD");
  });
});

describe("abandonment lead matching skips deactivated leads", () => {
  it("never selects a deactivated lead, even when it is the only match (the caller then falls through to the existing create-a-Lead path)", async () => {
    const { tx } = makeTx([lead("TEST", "+919876543210", 1, null, "DEACTIVATED")]);
    assert.equal(await findExistingLead(tx, { phone: "9876543210", email: null }), null);
  });

  it("prefers an active lead over an older deactivated one with the same number", async () => {
    const { tx } = makeTx([lead("OLD-TEST", "9876543210", 1, null, "DEACTIVATED"), lead("ACTIVE", "+919876543210", 20)]);
    assert.equal((await findExistingLead(tx, { phone: "+91 98765 43210", email: null }))?.id, "ACTIVE");
  });

  it("applies to an email-only match as well", async () => {
    const { tx } = makeTx([lead("TEST", null, 1, "a@b.com", "DEACTIVATED")]);
    assert.equal(await findExistingLead(tx, { phone: null, email: "a@b.com" }), null);
  });

  it("still matches leads in every non-deactivated status", async () => {
    for (const status of ["NEW", "ASSIGNED", "INTERESTED", "NOT_INTERESTED", "CONVERTED"]) {
      const { tx } = makeTx([lead("L", "+919876543210", 1, null, status)]);
      assert.equal((await findExistingLead(tx, { phone: "9876543210", email: null }))?.id, "L", status);
    }
  });
});

describe("repeat delivery for a cart whose open abandonment belongs to a deactivated lead", () => {
  // Intended behaviour, pinned here so a later change to it is deliberate: the deactivated lead is never the
  // target of a new event, so its open abandonment is neither found nor refreshed; the delivery gets its own
  // abandonment on the eligible lead (an existing active one, or a newly created one).
  const onDeactivatedLead: FakeAbandonment = { id: "A-OLD", leadId: "TEST", type: "CHECKOUT", referenceId: "cart-1", status: "ACTIVE", createdAt: 1 };

  it("is not matched to the deactivated lead, so it does not refresh that lead's abandonment", async () => {
    const { tx } = makeTx([lead("TEST", "+919876543210", 1, null, "DEACTIVATED")], [onDeactivatedLead]);
    assert.equal(await findExistingLead(tx, { phone: "9876543210", email: null }), null);
  });

  it("gets a fresh abandonment on the active lead: the old one is not reused for it", async () => {
    const { tx } = makeTx([lead("TEST", "+919876543210", 1, null, "DEACTIVATED"), lead("LIVE", "+919876543210", 20)], [onDeactivatedLead]);
    const target = await findExistingLead(tx, { phone: "9876543210", email: null });
    assert.equal(target?.id, "LIVE");
    assert.equal(await findOpenAbandonment(tx, target!.id, "cart-1"), null, "nothing open on LIVE, so a new abandonment is created there");
  });

  it("an open abandonment on the ACTIVE lead is still refreshed in place", async () => {
    const { tx } = makeTx([lead("TEST", "+919876543210", 1, null, "DEACTIVATED"), lead("LIVE", "+919876543210", 20)], [onDeactivatedLead, { ...onDeactivatedLead, id: "A-LIVE", leadId: "LIVE" }]);
    const target = await findExistingLead(tx, { phone: "9876543210", email: null });
    assert.equal((await findOpenAbandonment(tx, target!.id, "cart-1"))?.id, "A-LIVE");
  });
});

describe("abandonment idempotency", () => {
  const open = (over: Partial<FakeAbandonment> = {}): FakeAbandonment => ({ id: "A1", leadId: "L1", type: "CHECKOUT", referenceId: "cart-1", status: "ACTIVE", createdAt: 1, ...over });

  it("a repeat delivery for the same cart reuses the open abandonment", async () => {
    const { tx } = makeTx([], [open()]);
    assert.equal((await findOpenAbandonment(tx, "L1", "cart-1"))?.id, "A1");
  });

  it("an IN_PROGRESS abandonment is still reused", async () => {
    const { tx } = makeTx([], [open({ status: "IN_PROGRESS" })]);
    assert.equal((await findOpenAbandonment(tx, "L1", "cart-1"))?.id, "A1");
  });

  it("a different cart for the same lead is a legitimate separate abandonment", async () => {
    const { tx } = makeTx([], [open()]);
    assert.equal(await findOpenAbandonment(tx, "L1", "cart-2"), null);
  });

  it("another lead's cart with the same id is never reused", async () => {
    const { tx } = makeTx([], [open()]);
    assert.equal(await findOpenAbandonment(tx, "L2", "cart-1"), null);
  });

  it("a finished (recovered / expired / not recovered) abandonment is not reopened", async () => {
    for (const status of ["RECOVERED", "NOT_RECOVERED", "EXPIRED"]) {
      const { tx } = makeTx([], [open({ status })]);
      assert.equal(await findOpenAbandonment(tx, "L1", "cart-1"), null, status);
    }
  });

  it("deliveries with no cart id at all reuse the lead's open no-cart-id abandonment instead of piling up", async () => {
    const { tx } = makeTx([], [open({ referenceId: null })]);
    assert.equal((await findOpenAbandonment(tx, "L1", null))?.id, "A1");
  });

  it("a no-cart-id delivery never hijacks an abandonment that has a cart id", async () => {
    const { tx } = makeTx([], [open()]);
    assert.equal(await findOpenAbandonment(tx, "L1", null), null);
  });
});

describe("abandonment concurrency lock", () => {
  it("takes the same lock key for every format of one phone number, so concurrent deliveries serialise", async () => {
    const keys = new Set<string>();
    for (const phone of ["+91 98765 43210", "9876543210", "09876543210", "919876543210"]) {
      const { tx, locks } = makeTx([]);
      await lockContact(tx, { phone, email: null });
      assert.equal(locks.length, 1);
      keys.add(locks[0]!);
    }
    assert.equal(keys.size, 1);
  });

  it("different customers take different locks", async () => {
    const a = makeTx([]);
    const b = makeTx([]);
    await lockContact(a.tx, { phone: "9876543210", email: null });
    await lockContact(b.tx, { phone: "9876543211", email: null });
    assert.notEqual(a.locks[0], b.locks[0]);
  });

  it("falls back to email, and takes no lock when there is nothing to key on", async () => {
    const e = makeTx([]);
    await lockContact(e.tx, { phone: null, email: "a@b.com" });
    assert.equal(e.locks.length, 1);
    const n = makeTx([]);
    await lockContact(n.tx, { phone: null, email: null });
    assert.equal(n.locks.length, 0);
  });
});
