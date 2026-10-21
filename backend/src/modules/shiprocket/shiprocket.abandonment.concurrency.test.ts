import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAbandonmentEvent } from "./shiprocket.abandonment.mapper.js";
import { contactLockKeys, findExistingLead, lockContact, saveCheckoutAbandonment } from "./shiprocket.abandonment.processor.js";

// In-memory model of the save transaction (lock -> find/create lead -> find/create abandonment). The advisory
// locks really exclude each other and every read yields to the event loop, so an unprotected find-then-insert
// interleaves exactly as it does against Postgres. No database is touched.
interface Row { id: string; leadId: string; type: string; referenceId: string | null; status: string; detectedAt: Date; cartSnapshot: unknown }
interface Lead { id: string; normalizedMobile: string | null; normalizedEmail: string | null; createdAt: number; workingStatus: string }

const tick = () => new Promise<void>((r) => setImmediate(r));

function makeWorld(seed: { leads?: Lead[]; rows?: Row[] } = {}) {
  const leads: Lead[] = [...(seed.leads ?? [])];
  const rows: Row[] = [...(seed.rows ?? [])];
  const tails = new Map<string, Promise<void>>();
  let seq = 0;

  function newTx() {
    const releases: Array<() => void> = [];
    const tx = {
      async $executeRaw(_s: TemplateStringsArray, ...values: unknown[]) {
        const key = String(values[0]);
        const prev = tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((r) => (release = r));
        tails.set(key, prev.then(() => mine));
        await prev;
        releases.push(release);
        return 1;
      },
      lead: {
        async findFirst({ where }: any) {
          await tick();
          const m = leads.filter((l) => (where.normalizedMobile ? where.normalizedMobile.in.includes(l.normalizedMobile) : where.normalizedEmail ? where.normalizedEmail === l.normalizedEmail : false));
          return m[0] ? { id: m[0].id } : null;
        },
      },
      source: { async findFirst() { return { id: "src" }; } },
      abandonment: {
        async findFirst({ where }: any) {
          await tick();
          const r = rows.find((a) => a.leadId === where.leadId && a.type === where.type && a.referenceId === where.referenceId && where.status.in.includes(a.status));
          return r ? { id: r.id, detectedAt: r.detectedAt } : null;
        },
        async findUnique({ where }: any) { return rows.find((a) => a.id === where.id) ?? null; },
        async update({ where, data }: any) {
          const r = rows.find((a) => a.id === where.id)!;
          Object.assign(r, { detectedAt: data.detectedAt, cartSnapshot: data.cartSnapshot });
          return r;
        },
        async create({ data }: any) {
          await tick();
          const r: Row = { id: `A${++seq}`, leadId: data.leadId, type: data.type, referenceId: data.referenceId, status: data.status, detectedAt: data.detectedAt, cartSnapshot: data.cartSnapshot };
          rows.push(r);
          return r;
        },
      },
    };
    return { tx: tx as never, commit: () => releases.forEach((r) => r()) };
  }

  /** One delivery, shaped like the processor's SAVE transaction. */
  async function deliver(payload: Record<string, unknown>): Promise<{ leadId: string; abandonmentId: string; existing: boolean }> {
    const event = parseAbandonmentEvent(payload)!;
    const { tx, commit } = newTx();
    try {
      await lockContact(tx, event);
      let lead = await findExistingLead(tx, event);
      if (!lead) {
        await tick();
        const created: Lead = { id: `L${leads.length + 1}`, normalizedMobile: event.phone ? `+91${event.phone.replace(/\D/g, "").slice(-10)}` : null, normalizedEmail: event.email?.toLowerCase() ?? null, createdAt: leads.length, workingStatus: "NEW" };
        leads.push(created);
        lead = { id: created.id };
      }
      const { abandonment, existing } = await saveCheckoutAbandonment(tx, lead.id, event, { detectedAt: event.abandonedAt ?? new Date(0), score: null, reason: null });
      return { leadId: lead.id, abandonmentId: abandonment.id, existing };
    } finally {
      commit();
    }
  }

  return { leads, rows, deliver };
}

const cart = (over: Record<string, unknown> = {}) => ({
  cart_id: "cart-1",
  phone_number: "9057071293",
  email: "a@example.com",
  total_price: "649",
  items: [{ name: "Herbal Masala", quantity: 1, price: "649" }],
  updated_at: "2026-10-19T00:00:00Z",
  ...over,
});

describe("abandonment save: duplicates", () => {
  it("the same delivery processed twice in sequence yields one abandonment, refreshed in place", async () => {
    const w = makeWorld();
    const first = await w.deliver(cart());
    const second = await w.deliver(cart());
    assert.equal(w.rows.length, 1);
    assert.equal(first.existing, false);
    assert.equal(second.existing, true);
    assert.equal(second.abandonmentId, first.abandonmentId);
  });

  it("two identical deliveries processed concurrently yield one lead and one abandonment", async () => {
    const w = makeWorld();
    const [a, b] = await Promise.all([w.deliver(cart()), w.deliver(cart())]);
    assert.equal(w.leads.length, 1);
    assert.equal(w.rows.length, 1);
    assert.equal(a.abandonmentId, b.abandonmentId);
    assert.deepEqual([a.existing, b.existing].sort(), [false, true]);
  });

  it("many concurrent retries of one cart still yield one abandonment", async () => {
    const w = makeWorld();
    await Promise.all(Array.from({ length: 8 }, () => w.deliver(cart())));
    assert.equal(w.rows.length, 1);
  });

  it("a phone+email delivery racing an email-only delivery for the same cart is serialised (the lock covers both identifiers)", async () => {
    const lead: Lead = { id: "L1", normalizedMobile: "+919057071293", normalizedEmail: "a@example.com", createdAt: 0, workingStatus: "NEW" };
    const w = makeWorld({ leads: [lead] });
    const [a, b] = await Promise.all([w.deliver(cart()), w.deliver(cart({ phone_number: undefined }))]);
    assert.equal(a.leadId, b.leadId);
    assert.equal(w.rows.length, 1);
  });

  it("the lock keys of two deliveries sharing an identifier overlap, are sorted, and never contain duplicates", () => {
    const both = contactLockKeys({ phone: "9057071293", email: "A@example.com" });
    const emailOnly = contactLockKeys({ phone: null, email: "a@example.com" });
    assert.equal(both.length, 2);
    assert.deepEqual([...both].sort(), both);
    assert.ok(both.includes(emailOnly[0]!));
    assert.equal(contactLockKeys({ phone: "9057071293", email: null }).length, 1);
    assert.deepEqual(contactLockKeys({ phone: null, email: null }), []);
  });
});

describe("abandonment save: legitimate rows are preserved", () => {
  it("two genuinely different carts for one lead (concurrent) both stay", async () => {
    const w = makeWorld();
    const [a, b] = await Promise.all([w.deliver(cart({ cart_id: "cart-1" })), w.deliver(cart({ cart_id: "cart-2" }))]);
    assert.equal(w.rows.length, 2);
    assert.notEqual(a.abandonmentId, b.abandonmentId);
    assert.equal(new Set(w.rows.map((r) => r.id)).size, 2);
  });

  it("a new abandonment after the previous one was recovered is a new row, and the recovered row is untouched", async () => {
    const w = makeWorld();
    const first = await w.deliver(cart());
    const recovered = w.rows.find((r) => r.id === first.abandonmentId)!;
    recovered.status = "RECOVERED";
    const snapshot = JSON.stringify(recovered);
    const again = await w.deliver(cart());
    assert.equal(w.rows.length, 2);
    assert.notEqual(again.abandonmentId, first.abandonmentId);
    assert.equal(JSON.stringify(w.rows.find((r) => r.id === first.abandonmentId)), snapshot);
  });

  it("the listing never sees one abandonment id twice after repeated and concurrent deliveries", async () => {
    const w = makeWorld();
    await Promise.all([w.deliver(cart()), w.deliver(cart()), w.deliver(cart({ cart_id: "cart-2" })), w.deliver(cart({ cart_id: "cart-2" }))]);
    await w.deliver(cart());
    const ids = w.rows.map((r) => r.id);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, ids.length);
  });
});
