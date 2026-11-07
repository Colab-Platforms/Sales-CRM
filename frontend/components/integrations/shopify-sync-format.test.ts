// Run with: ../backend/node_modules/.bin/tsx --test components/integrations/shopify-sync-format.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NAV_BY_ROLE } from "../app-sidebar";
import { formatSyncStatus } from "./shopify-sync-format";

describe("Shopify sync settings wording", () => {
  it("shows ON (the default) until the setting has ever been saved", () => {
    assert.equal(formatSyncStatus(undefined).badge, "ON");
    const s = formatSyncStatus({ enabled: true, updatedAt: null, updatedById: null });
    assert.equal(s.badge, "ON");
    assert.match(s.updated, /default is ON/);
    assert.equal(formatSyncStatus({ enabled: false, updatedAt: null, updatedById: null }).badge, "OFF");
  });
  it("shows ON when enabled, with the date it was changed", () => {
    const s = formatSyncStatus({ enabled: true, updatedAt: "2026-11-03T10:00:00.000Z", updatedById: "a" });
    assert.equal(s.badge, "ON");
    assert.match(s.updated, /Last changed/);
  });
  it("only the Admin menu links to the Shopify settings page", () => {
    const has = (role: keyof typeof NAV_BY_ROLE) => JSON.stringify(NAV_BY_ROLE[role]).includes("/dashboard/integrations/shopify");
    assert.equal(has("ADMIN"), true);
    for (const role of Object.keys(NAV_BY_ROLE) as (keyof typeof NAV_BY_ROLE)[]) if (role !== "ADMIN") assert.equal(has(role), false, role);
  });
});
