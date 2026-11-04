// Run with: npx tsx --test src/modules/settings/shopify-sync.setting.test.ts
// No database and no Shopify: the settings reads/writes use a scripted fake, and the order service gets a Shopify client factory that FAILS THE TEST if it is ever asked for a client.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decideShopifySyncForNewOrder, readShopifySyncSetting, shopifyPushBlocked, storedShopifySyncDecision, writeShopifySyncSetting, SHOPIFY_SYNC_OFF_REASON } from "./shopify-sync.setting.js";
import { parseShopifySyncBody } from "../integrations/integrations.shopify-sync.controller.js";
import OrdersService from "../orders/orders.service.js";
import { requireRole } from "../../middlewares/auth.js";
import integrationsRouter from "../integrations/integrations.routes.js";

const sql = (s: TemplateStringsArray) => s.join("?");

/** A scripted stand-in for the two raw calls the setting module makes. `row` = the app_setting row (undefined = never configured); `tableExists` = false before the migration. */
function fakeSettingsDb(state: { tableExists?: boolean; row?: { enabled: boolean } }) {
  return {
    $queryRaw: async (s: TemplateStringsArray) => {
      if (sql(s).includes("to_regclass")) return [{ t: state.tableExists === false ? null : "app_setting" }];
      return state.row ? [{ value: state.row, updatedAt: new Date("2026-11-03T00:00:00Z"), updatedById: "admin-1" }] : [];
    },
    $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
      state.row = JSON.parse(String(v[1]));
      state.tableExists = true;
      return 1;
    },
  };
}

describe("the setting itself", () => {
  it("defaults to ON: never configured, or the table is not there yet", async () => {
    assert.equal((await readShopifySyncSetting(fakeSettingsDb({}) as never)).enabled, true);
    assert.equal((await readShopifySyncSetting(fakeSettingsDb({ tableExists: false }) as never)).enabled, true);
    assert.equal((await decideShopifySyncForNewOrder(fakeSettingsDb({}) as never, new Date())).enabled, true);
    assert.equal((await readShopifySyncSetting(fakeSettingsDb({ row: { enabled: false } }) as never)).enabled, false, "a saved OFF is kept");
  });
  it("an Admin can turn it ON and OFF, and the value is what is read back", async () => {
    const db = fakeSettingsDb({});
    assert.equal((await writeShopifySyncSetting(db as never, false, "admin-1")).enabled, false);
    assert.equal((await writeShopifySyncSetting(db as never, true, "admin-1")).enabled, true);
    assert.equal((await readShopifySyncSetting(db as never)).enabled, true);
    assert.equal((await decideShopifySyncForNewOrder(db as never, new Date())).enabled, true);
    assert.equal((await writeShopifySyncSetting(db as never, false, "admin-1")).enabled, false);
    assert.equal((await readShopifySyncSetting(db as never)).enabled, false);
  });
  it("only a real boolean is accepted", () => {
    assert.deepEqual(parseShopifySyncBody({ enabled: true }), { enabled: true });
    assert.deepEqual(parseShopifySyncBody({ enabled: false }), { enabled: false });
    for (const bad of [null, undefined, {}, { enabled: "true" }, { enabled: 1 }, "x"]) assert.equal(parseShopifySyncBody(bad), null);
  });
  it("the migration only creates the table (no row, no default change) and is safe to re-run", () => {
    const text = readFileSync(join(import.meta.dirname, "../../../prisma/migrations/20261103000000_app_setting/migration.sql"), "utf8").split("\n").filter((l) => !l.startsWith("--")).join("\n");
    assert.match(text, /CREATE TABLE IF NOT EXISTS "app_setting"/);
    assert.doesNotMatch(text, /(INSERT|UPDATE|DELETE|DROP|ALTER)/i);
  });
});

describe("only an Admin can change it", () => {
  it("the routes sit behind the Admin gate, and the role check refuses everyone else", () => {
    const stack = (integrationsRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> }; name: string }[] }).stack;
    const idx = (method: string) => stack.findIndex((l) => l.route?.path === "/shopify/crm-order-sync" && l.route.methods[method]);
    assert.ok(idx("get") > -1 && idx("put") > -1);
    const lastGate = Math.max(...stack.map((l, i) => (l.route ? -1 : i)));
    assert.ok(lastGate < idx("get") && lastGate < idx("put"), "every router-level gate (requireAuth, requireRole ADMIN) is registered before the setting routes");
    for (const role of ["SALESPERSON", "MANAGER", "TELECALLER", undefined]) {
      let err: unknown = null;
      requireRole("ADMIN" as never)({ user: role ? { role } : undefined } as never, {} as never, (e?: unknown) => { err = e ?? null; });
      assert.ok(err, `${String(role)} is refused`);
    }
    let refused = true;
    requireRole("ADMIN" as never)({ user: { role: "ADMIN" } } as never, {} as never, (e?: unknown) => { refused = Boolean(e); });
    assert.equal(refused, false);
  });
});

describe("the saved decision on each order", () => {
  const off = { shopifySyncDecision: { enabled: false, decidedAt: "2026-11-03T00:00:00Z" } };
  const on = { shopifySyncDecision: { enabled: true, decidedAt: "2026-11-03T00:00:00Z" } };
  it("blocks only a CRM-created order saved as OFF", () => {
    assert.equal(shopifyPushBlocked({ source: "SALESPERSON", metadata: off }), true);
    assert.equal(shopifyPushBlocked({ source: "SALESPERSON", metadata: on }), false);
  });
  it("an order with no saved decision (created before this feature) behaves exactly as before", () => {
    assert.equal(shopifyPushBlocked({ source: "SALESPERSON", metadata: { paymentMode: "COD" } }), false);
    assert.equal(shopifyPushBlocked({ source: "SALESPERSON", metadata: null }), false);
    assert.equal(storedShopifySyncDecision({ shopifySyncDecision: { enabled: "no" } }), null);
  });
  it("Shopify-originated orders are never affected, even with a stray decision", () => {
    assert.equal(shopifyPushBlocked({ source: "SHOPIFY", metadata: off }), false);
    assert.equal(shopifyPushBlocked({ source: "SHOPIFY", metadata: {} }), false);
  });
  it("the decision is separate from Order.metadata.shopifySync (the last-sync record)", () => {
    assert.equal(storedShopifySyncDecision({ shopifySync: { status: "complete" } }), null);
  });
  it("changing the global switch later leaves an existing order's decision as it was saved", async () => {
    const db = fakeSettingsDb({ row: { enabled: false } });
    const decided = await decideShopifySyncForNewOrder(db as never, new Date());
    const order = { source: "SALESPERSON", metadata: { shopifySyncDecision: decided } };
    assert.equal(shopifyPushBlocked(order), true);
    await writeShopifySyncSetting(db as never, true, "admin-1");
    assert.equal(shopifyPushBlocked(order), true, "still OFF for the order created while the switch was OFF");
    const later = { source: "SALESPERSON", metadata: { shopifySyncDecision: await decideShopifySyncForNewOrder(db as never, new Date()) } };
    assert.equal(shopifyPushBlocked(later), false);
    await writeShopifySyncSetting(db as never, false, "admin-1");
    assert.equal(shopifyPushBlocked(later), false, "still ON for the order created while the switch was ON");
  });
});

/** An OrdersService over a fake order table. If anything asks for a Shopify client, the test fails. */
function serviceFor(order: { source: string; metadata: unknown; externalId?: string | null }) {
  let claims = 0;
  const db = {
    order: {
      findFirst: async () => ({ id: "o1", externalId: order.externalId ?? null, externalNumber: null, source: order.source, metadata: order.metadata }),
      findUnique: async () => ({ id: "o1", source: order.source, metadata: order.metadata, externalId: order.externalId ?? null, externalNumber: null, payments: [] }),
    },
    // The first thing the existing path does is claim the order; reaching it is what these tests look for, so it stops the push there instead of waiting out the claim lease.
    $executeRaw: async () => {
      claims++;
      throw new Error("claim reached");
    },
  };
  const svc = new OrdersService(db as never, () => assert.fail("Shopify must not be contacted"));
  return { svc, claims: () => claims };
}
type Placeholder = { prepaidShopifyPlaceholder(id: string): Promise<{ status: string }> };

describe("a CRM order saved as OFF never reaches Shopify, whichever path asks", () => {
  for (const role of ["Telecaller", "Admin", "Manager"]) {
    it(`${role}-created COD order: the push is skipped before any claim or Shopify call; retries do the same`, async () => {
      const { svc, claims } = serviceFor({ source: "SALESPERSON", metadata: { paymentMode: "COD", shopifySyncDecision: { enabled: false, decidedAt: "x" }, createdBy: { role } } });
      for (let i = 0; i < 3; i++) {
        const r = await svc.pushOrderToShopify(null, "o1");
        assert.equal(r.status, "skipped");
        assert.equal(r.reason, SHOPIFY_SYNC_OFF_REASON);
      }
      assert.equal(claims(), 0, "no claim, so no retry or background job can start a create");
    });
  }
  it("prepaid order after a verified payment (push with no user, as the webhook does): skipped, no draft or order", async () => {
    const { svc } = serviceFor({ source: "SALESPERSON", metadata: { paymentMode: "PREPAID", shopifySyncDecision: { enabled: false, decidedAt: "x" } } });
    assert.equal((await svc.pushOrderToShopify(null, "o1")).status, "skipped");
  });
  it("the prepaid 'awaiting payment' answer becomes 'skipped' for an OFF order, and is unchanged for an ON order", async () => {
    const off = serviceFor({ source: "SALESPERSON", metadata: { shopifySyncDecision: { enabled: false, decidedAt: "x" } } }).svc as unknown as Placeholder;
    assert.equal((await off.prepaidShopifyPlaceholder("o1")).status, "skipped");
    const on = serviceFor({ source: "SALESPERSON", metadata: { shopifySyncDecision: { enabled: true, decidedAt: "x" } } }).svc as unknown as Placeholder;
    assert.equal((await on.prepaidShopifyPlaceholder("o1")).status, "awaiting_payment");
  });
});

describe("with the saved decision ON (or none), the existing workflow is untouched", () => {
  for (const [label, metadata] of [["ON", { shopifySyncDecision: { enabled: true, decidedAt: "x" } }], ["no decision (older order)", {}]] as const) {
    it(`${label}: the push goes through the existing claim path`, async () => {
      const { svc, claims } = serviceFor({ source: "SALESPERSON", metadata });
      const r = await svc.pushOrderToShopify(null, "o1").catch((e: unknown) => e);
      assert.notEqual((r as { status?: string }).status, "skipped");
      assert.ok(claims() > 0, "the existing claim was attempted");
    });
  }
  it("an order already linked to Shopify is still reported as already_linked (no second order)", async () => {
    const { svc, claims } = serviceFor({ source: "SALESPERSON", externalId: "123", metadata: { shopifySyncDecision: { enabled: true, decidedAt: "x" } } });
    const r = await svc.pushOrderToShopify(null, "o1").catch((e: unknown) => e);
    assert.equal((r as { status?: string }).status, "already_linked");
    assert.equal(claims(), 0);
  });
});

describe("Shopify-originated orders", () => {
  it("are never gated, even when their metadata happens to look like an OFF decision", async () => {
    const { svc, claims } = serviceFor({ source: "SHOPIFY", metadata: { shopifySyncDecision: { enabled: false, decidedAt: "x" } } });
    const r = await svc.pushOrderToShopify(null, "o1").catch((e: unknown) => e);
    assert.notEqual((r as { status?: string }).status, "skipped");
    assert.ok(claims() > 0);
  });
});

describe("Shiprocket stays independent of the Shopify switch", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.includes("test") ? [join(dir, e.name)] : []));
  it("no Shiprocket module reads the setting, the saved decision, or the push gate", () => {
    for (const f of files(join(import.meta.dirname, "../shiprocket"))) {
      assert.doesNotMatch(readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, ""), /shopify-sync\.setting|shopifySyncDecision|shopifyPushBlocked|crm-order-sync/, f);
    }
  });
  it("shipment creation builds its channel order id from the CRM order number (suffixed only for a later attempt), not from any Shopify link", () => {
    const src = readFileSync(join(import.meta.dirname, "../shiprocket/shiprocket.shipments.service.ts"), "utf8");
    assert.match(src, /channelOrderId = \(order\.shipments\.length === 0 \? order\.orderNumber : `\$\{order\.orderNumber\}-/);
    assert.doesNotMatch(src, /order\.externalId|order\.externalNumber/);
  });
  it("the OFF decision is applied in exactly one place: the Shopify push", () => {
    const orders = readFileSync(join(import.meta.dirname, "../orders/orders.service.ts"), "utf8");
    assert.equal(orders.split("shopifyPushBlocked(visible)").length - 1, 1);
  });
});
