// Run with: ../backend/node_modules/.bin/tsx --test lib/demo.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEMO_NAV_HREFS, demoUrl, isDemoUser } from "./demo";

describe("demo routing helpers", () => {
  it("every demo request path is placed under /demo, once; absolute URLs are untouched", () => {
    assert.equal(demoUrl("/lead/leads"), "/demo/lead/leads");
    assert.equal(demoUrl("orders/live"), "/demo/orders/live");
    assert.equal(demoUrl("/demo/session/role"), "/demo/session/role");
    assert.equal(demoUrl("https://example.com/x"), "https://example.com/x");
  });
  it("only a user flagged demo is a demo user", () => {
    assert.equal(isDemoUser({ demo: true }), true);
    assert.equal(isDemoUser({}), false);
    assert.equal(isDemoUser(null), false);
  });
  it("demo menus are short, start at the dashboard, and never list real-integration screens", () => {
    for (const hrefs of Object.values(DEMO_NAV_HREFS)) {
      assert.equal(hrefs[0], "/dashboard");
      assert.ok(!hrefs.some((h) => /whatsapp|shiprocket|reconciliation|integrations|refunds|audit|recordings|incentives/.test(h)));
    }
  });
});
