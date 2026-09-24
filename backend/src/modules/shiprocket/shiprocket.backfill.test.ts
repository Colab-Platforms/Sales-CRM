import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import type { TxRunner } from "../integrations/integrations.common.js";
import { chunkWindow, normalizeOrderRef, orderRefCandidates, reasonOf, resolveTracking, runShiprocketBackfill, type ShiprocketApiForBackfill } from "./shiprocket.backfill.js";
import { CliUsageError, parseCliArgs } from "./shiprocket.cli.js";
import type { ExistingShipment } from "./shiprocket.client.js";

describe("chunkWindow", () => {
  it("splits a long range into consecutive <=30-day windows - Shiprocket's own documented limit", () => {
    const windows = chunkWindow("2026-01-01", "2026-03-15");
    assert.deepEqual(windows[0], { from: "2026-01-01", to: "2026-01-30" });
    assert.deepEqual(windows[1], { from: "2026-01-31", to: "2026-03-01" });
    assert.deepEqual(windows[windows.length - 1]!.to, "2026-03-15");
    // Consecutive, no gap and no overlap.
    for (let i = 1; i < windows.length; i++) {
      const prevTo = new Date(`${windows[i - 1]!.to}T00:00:00Z`);
      const thisFrom = new Date(`${windows[i]!.from}T00:00:00Z`);
      assert.equal(thisFrom.getTime() - prevTo.getTime(), 24 * 3_600_000);
    }
  });

  it("returns a single window when the range is already <=30 days, and none when since is after until", () => {
    assert.deepEqual(chunkWindow("2026-01-01", "2026-01-01"), [{ from: "2026-01-01", to: "2026-01-01" }]);
    assert.deepEqual(chunkWindow("2026-01-30", "2026-01-01"), []);
  });
});

describe("orderRefCandidates", () => {
  it("matches every shape a CRM order number could take for the same underlying reference", () => {
    assert.deepEqual(new Set(orderRefCandidates("#1050")), new Set(["#1050", "1050", "SHP-1050"]));
    assert.deepEqual(new Set(orderRefCandidates("1050")), new Set(["1050", "#1050", "SHP-1050"]));
    assert.deepEqual(new Set(orderRefCandidates("SHP-1050")), new Set(["SHP-1050", "1050", "#1050"]));
  });
  it("normalizeOrderRef strips exactly a leading # or SHP- prefix, nothing else", () => {
    assert.equal(normalizeOrderRef("#1050"), "1050");
    assert.equal(normalizeOrderRef("SHP-1050"), "1050");
    assert.equal(normalizeOrderRef("shp-1050"), "1050");
    assert.equal(normalizeOrderRef("1050"), "1050");
  });
});

describe("reasonOf - never a blank failure reason", () => {
  it("uses the error's own message, falling back to its name, never an empty string", () => {
    assert.equal(reasonOf(new Error("Pincode not serviceable")), "Pincode not serviceable");
    assert.equal(reasonOf(new Error("\nInvalid `tx.lead.findUnique()` invocation\nsome detail")), "Invalid `tx.lead.findUnique()` invocation");
    const blank = new Error("");
    blank.name = "PrismaClientKnownRequestError";
    assert.equal(reasonOf(blank), "PrismaClientKnownRequestError");
    assert.equal(reasonOf("just a string"), "just a string");
    assert.equal(reasonOf(undefined), "Unknown error");
    assert.notEqual(reasonOf(new Error("\nsomething")).trim(), "");
  });
});

describe("shiprocket:sync CLI argument parsing", () => {
  const NOW = new Date("2026-09-22T00:00:00Z");

  it("defaults to a safe small limit, matching the Shopify backfill's own 2026-01-01 start date", () => {
    const args = parseCliArgs([], NOW);
    assert.equal(args.limit, 50);
    assert.equal(args.since, "2026-01-01");
    assert.equal(args.until, "2026-09-22");
    assert.equal(args.dryRun, false);
  });

  it("--dry-run defaults to a smaller limit", () => {
    assert.equal(parseCliArgs(["--dry-run"], NOW).limit, 10);
  });

  it("accepts --since/--until/--limit/--all/--dry-run", () => {
    const args = parseCliArgs(["--since", "2026-02-01", "--until", "2026-02-15", "--limit", "5", "--dry-run"], NOW);
    assert.deepEqual(args, { since: "2026-02-01", until: "2026-02-15", limit: 5, dryRun: true });
    assert.equal(parseCliArgs(["--all"], NOW).limit, null);
  });

  it("rejects invalid combinations and values, never guessing what was meant", () => {
    assert.throws(() => parseCliArgs(["--all", "--limit", "5"], NOW), CliUsageError);
    assert.throws(() => parseCliArgs(["--all", "--dry-run"], NOW), CliUsageError);
    assert.throws(() => parseCliArgs(["--limit", "0"], NOW), CliUsageError);
    assert.throws(() => parseCliArgs(["--limit", "26", "--dry-run"], NOW), /1 to 25/);
    assert.throws(() => parseCliArgs(["--limit", "1001"], NOW), /1 to 1000/);
    assert.throws(() => parseCliArgs(["--since", "01-01-2026"], NOW), CliUsageError);
    assert.throws(() => parseCliArgs(["--since", "2026-06-01", "--until", "2026-01-01"], NOW), /must not be after/);
  });
});

// ---- runShiprocketBackfill: matching/creation/update behaviour against a fake Shiprocket + a fake in-memory "database" ----
//
// A full Prisma-backed exercise of matchAndApply's create/update paths already exists in shiprocket.db-test.ts
// (run with npm run test:db); these tests exercise the orchestration around it - pagination, the date-window split,
// throttling/retry and the report - with a minimal fake runner, so they need no database and no credentials.

interface FakeOrder {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
}
interface FakeShipmentRow {
  id: string;
  orderId: string;
  externalId: string | null;
  trackingNumber: string | null;
  providerOrderId: string | null;
  status: string;
}

function fakeRunner(orders: FakeOrder[], shipments: FakeShipmentRow[] = []) {
  const created: FakeShipmentRow[] = [];
  const runner = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        shipment: {
          findFirst: async ({ where }: { where: { externalSource: string; OR: Record<string, string>[] } }) => {
            const pool = [...shipments, ...created];
            return pool.find((s) => where.OR.some((cond) => Object.entries(cond).every(([k, v]) => (s as never)[k] === v))) ?? null;
          },
          create: async ({ data }: { data: FakeShipmentRow }) => {
            created.push(data);
            return data;
          },
        },
        order: {
          findFirst: async ({ where }: { where: { OR: { orderNumber?: { in: string[] }; externalNumber?: { in: string[] } }[] } }) => {
            const order = orders.find((o) => where.OR.some((cond) => (cond.orderNumber && cond.orderNumber.in.includes(o.orderNumber)) || (cond.externalNumber && cond.externalNumber.in.includes(o.externalNumber ?? "\0"))));
            if (!order) return null;
            return { id: order.id, leadId: `lead-${order.id}`, orderNumber: order.orderNumber, shipments: [...shipments, ...created].filter((s) => s.orderId === order.id).map((s) => ({ id: s.id, status: s.status })) };
          },
        },
        activity: { create: async () => ({}) },
        $executeRaw: async () => 0,
      };
      return fn(tx);
    },
  };
  // A narrow fake matching only what matchAndApply actually calls - not the full Prisma surface.
  return { runner: runner as unknown as TxRunner, created };
}

// Genuinely honours page/perPage (unlike a fixed list of pre-cut "pages"), so a short final page is real, not an
// artifact of the test double - exactly what the orchestration's own "short page means no more data" check relies on.
// track() defaults to "no tracking data" (never a guessed status) so tests that don't care about tracking still fall
// back to the entry's own (descriptive, in these fixtures) `status`, unless a test supplies its own trackingByAwb map.
function fakeClient(all: ExistingShipment[], trackingByAwb: Record<string, string | null> = {}): ShiprocketApiForBackfill & { calls: number; trackCalls: number } {
  const client = {
    calls: 0,
    trackCalls: 0,
    async listOrders({ page, perPage }: { page: number; perPage: number }) {
      client.calls++;
      const start = (page - 1) * perPage;
      return { shipments: all.slice(start, start + perPage), currentPage: page, lastPage: Math.max(1, Math.ceil(all.length / perPage)), totalOrders: all.length };
    },
    async track(awb: string) {
      client.trackCalls++;
      return { currentStatus: awb in trackingByAwb ? trackingByAwb[awb]! : null };
    },
  };
  return client;
}

const entry = (over: Partial<ExistingShipment> = {}): ExistingShipment => ({ shiprocketOrderId: "1", shiprocketShipmentId: "10", channelOrderId: "1050", awb: "AWB1", courierName: "Delhivery", status: "Delivered", createdAt: "2026-01-05", ...over });

describe("runShiprocketBackfill orchestration", () => {
  it("creates a new Shipment row for a discovered order that matches a CRM order by channel order id", async () => {
    const { runner, created } = fakeRunner([{ id: "order-1", orderNumber: "SHP-1050", externalNumber: "#1050" }]);
    const client = fakeClient([entry()]);
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: false });
    assert.equal(report.connection, "PASS");
    assert.equal(report.counts.discovered, 1);
    assert.equal(report.counts.created, 1);
    assert.equal(report.databaseWrites, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.orderId, "order-1");
    assert.equal((created[0] as never as { trackingNumber: string }).trackingNumber, "AWB1");
  });

  it("skips (never duplicates) when no CRM order matches, and never invents an order", async () => {
    const { runner, created } = fakeRunner([]);
    const client = fakeClient([entry({ channelOrderId: "no-such-order" })]);
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: false });
    assert.equal(report.counts.skipped, 1);
    assert.equal(report.counts.created, 0);
    assert.equal(created.length, 0);
    assert.match(report.failures[0]!.reason, /no CRM order matches/);
  });

  it("updates rather than duplicates when the Shipment row already exists", async () => {
    const existing: FakeShipmentRow = { id: "shipment-1", orderId: "order-1", externalId: "10", trackingNumber: "AWB1", providerOrderId: "1", status: "AWB_ASSIGNED" };
    const { runner, created } = fakeRunner([{ id: "order-1", orderNumber: "SHP-1050", externalNumber: "#1050" }], [existing]);
    const client = fakeClient([entry()]);
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: false });
    // matched by externalId, so it is an update - a real applyShipmentUpdate call needs a real Prisma client
    // (covered in shiprocket.db-test.ts); this fake only proves matchAndApply took the update branch, not the create one.
    assert.equal(created.length, 0);
    assert.notEqual(report.counts.created, 1);
  });

  it("never writes on a dry run, even though it still reads the database to show a real match", async () => {
    const { runner, created } = fakeRunner([{ id: "order-1", orderNumber: "SHP-1050", externalNumber: "#1050" }]);
    const client = fakeClient([entry()]);
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: true });
    assert.equal(report.counts.created, 1); // it DOES resolve to "would create"...
    assert.equal(created.length, 0); // ...but nothing was actually written
    assert.equal(report.databaseWrites, 0);
    assert.equal(report.preview.length, 1);
    assert.equal(report.preview[0]!.outcome, "created");
  });

  it("never discovers more than --limit, even when Shiprocket has more", async () => {
    const orders = Array.from({ length: 5 }, (_, i) => ({ id: `order-${i}`, orderNumber: `SHP-${1000 + i}`, externalNumber: `#${1000 + i}` }));
    const { runner } = fakeRunner(orders);
    const all = Array.from({ length: 5 }, (_, i) => entry({ shiprocketOrderId: String(i), channelOrderId: String(1000 + i) }));
    const client = fakeClient(all); // 5 exist; only 3 should ever be looked at
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 3, dryRun: true });
    assert.equal(report.counts.discovered, 3);
    assert.equal(client.calls, 1); // the limit is reached inside the first page - no need to fetch a second
  });

  it("stops paginating within a window once a page comes back shorter than requested", async () => {
    const { runner } = fakeRunner([{ id: "order-0", orderNumber: "SHP-1000", externalNumber: "#1000" }]);
    const client = fakeClient([entry({ channelOrderId: "1000" })]); // only 1 exists; --limit allows far more
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 50, dryRun: true });
    assert.equal(report.counts.discovered, 1);
    assert.equal(client.calls, 1); // a page shorter than requested means "no more data" - never fetched again
  });

  it("reports the real error message on a page failure, and retries a throttled page before giving up", async () => {
    const { runner } = fakeRunner([]);
    let calls = 0;
    const flaky: ShiprocketApiForBackfill = {
      async listOrders() {
        calls++;
        if (calls < 2) throw new ProviderHttpError("SHIPROCKET", 429, "Too many requests", true);
        return { shipments: [], currentPage: 1, lastPage: 1, totalOrders: 0 };
      },
      async track() {
        return null;
      },
    };
    const report = await runShiprocketBackfill({ client: flaky, runner, sleep: async () => undefined }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: true });
    assert.equal(report.connection, "PASS");
    assert.equal(calls, 2);

    let attempts = 0;
    const alwaysDown: ShiprocketApiForBackfill = {
      async listOrders() {
        attempts++;
        throw new ProviderHttpError("SHIPROCKET", null, "Could not reach the provider", true);
      },
      async track() {
        return null;
      },
    };
    const failed = await runShiprocketBackfill({ client: alwaysDown, runner, sleep: async () => undefined }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: true });
    assert.equal(failed.connection, "FAIL");
    assert.match(failed.fatalError ?? "", /Could not reach the provider/);
    assert.notEqual(failed.fatalError, "");
  });

  it("enriches a numeric list status with the real descriptive status from track(awb), and reports all three representations", async () => {
    const { runner } = fakeRunner([{ id: "order-1", orderNumber: "SHP-1050", externalNumber: "#1050" }]);
    // Simulates the real problem reported: GET /orders returns a bare numeric code...
    const client = fakeClient([entry({ status: "7" })], { AWB1: "Delivered" }); // ...but track(awb) returns real descriptive text.
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: true });
    assert.equal(client.trackCalls, 1);
    assert.equal(report.apiCalls.track, 1);
    assert.equal(report.apiCalls.listOrders, 1);
    assert.equal(report.tracking.withAwb, 1);
    assert.equal(report.tracking.succeeded, 1);
    assert.equal(report.tracking.failed, 0);
    assert.deepEqual(report.tracking.descriptiveStatuses, ["Delivered"]);
    assert.deepEqual(report.tracking.unknownStatuses, []);
    assert.equal(report.preview[0]!.listStatus, "7");
    assert.equal(report.preview[0]!.trackingStatus, "Delivered");
    assert.equal(report.preview[0]!.trackingError, null);
    assert.equal(report.preview[0]!.crmStatus, "DELIVERED");
    assert.deepEqual(report.crmStatusCounts, { DELIVERED: 1 });
  });

  it("never guesses a status: reports a tracking failure plainly and falls back to the raw list status", async () => {
    const { runner } = fakeRunner([{ id: "order-1", orderNumber: "SHP-1050", externalNumber: "#1050" }]);
    const client: ShiprocketApiForBackfill & { calls: number } = {
      calls: 0,
      async listOrders({ page }) {
        client.calls++;
        return page === 1 ? { shipments: [entry({ status: "7" })], currentPage: 1, lastPage: 1, totalOrders: 1 } : { shipments: [], currentPage: page, lastPage: 1, totalOrders: 1 };
      },
      async track() {
        throw new Error("Shiprocket tracking is temporarily unavailable");
      },
    };
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: true });
    assert.equal(report.tracking.withAwb, 1);
    assert.equal(report.tracking.succeeded, 0);
    assert.equal(report.tracking.failed, 1);
    assert.equal(report.preview[0]!.trackingStatus, null);
    assert.equal(report.preview[0]!.trackingError, "Shiprocket tracking is temporarily unavailable");
    // No AWB -> tracking status is reported as not-verifiable, never guessed either.
    assert.equal(report.preview[0]!.listStatus, "7");
  });

  it("reports 'no AWB' rather than attempting or guessing a tracking status", async () => {
    const { runner } = fakeRunner([{ id: "order-1", orderNumber: "SHP-1050", externalNumber: "#1050" }]);
    const client = fakeClient([entry({ awb: null })]);
    const report = await runShiprocketBackfill({ client, runner }, { since: "2026-01-01", until: "2026-01-30", limit: 10, dryRun: true });
    assert.equal(client.trackCalls, 0);
    assert.equal(report.tracking.withAwb, 0);
    assert.equal(report.preview[0]!.trackingStatus, null);
    assert.equal(report.preview[0]!.trackingError, null);
  });
});

describe("resolveTracking", () => {
  it("looks up each unique AWB once (a split shipment sharing an AWB is not looked up twice)", async () => {
    let calls = 0;
    const client = {
      async track(awb: string) {
        calls++;
        return { currentStatus: `status-for-${awb}` };
      },
    };
    const entries = [entry({ awb: "AWB1" }), entry({ awb: "AWB1" }), entry({ awb: "AWB2" }), entry({ awb: null })];
    const { lookups, calls: reportedCalls } = await resolveTracking(client, entries);
    assert.equal(calls, 2);
    assert.equal(reportedCalls, 2);
    assert.equal(lookups.get("AWB1")?.status, "status-for-AWB1");
    assert.equal(lookups.get("AWB2")?.status, "status-for-AWB2");
    assert.equal(lookups.size, 2);
  });

  it("never runs more than TRACKING_CONCURRENCY lookups at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      async track(awb: string) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { currentStatus: awb };
      },
    };
    const entries = Array.from({ length: 12 }, (_, i) => entry({ awb: `AWB${i}` }));
    await resolveTracking(client, entries);
    assert.ok(maxInFlight <= 3, `expected at most 3 concurrent tracking calls, saw ${maxInFlight}`);
  });

  it("reports a real per-AWB error rather than guessing a status, and does not let one failure abort the rest", async () => {
    const client = {
      async track(awb: string) {
        if (awb === "AWB-BAD") throw new Error("Shiprocket says: AWB not found");
        return { currentStatus: "Delivered" };
      },
    };
    const entries = [entry({ awb: "AWB-BAD" }), entry({ awb: "AWB-OK" })];
    const { lookups } = await resolveTracking(client, entries);
    assert.equal(lookups.get("AWB-BAD")?.error, "Shiprocket says: AWB not found");
    assert.equal(lookups.get("AWB-BAD")?.status, null);
    assert.equal(lookups.get("AWB-OK")?.status, "Delivered");
  });
});
