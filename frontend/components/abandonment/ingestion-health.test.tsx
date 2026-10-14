// Fastrr ingestion health panel: the numbers, the alert and the admin-only re-process action.
// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/ingestion-health.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { IngestionHealthView, ago } from "./ingestion-health";
import type { IngestionStatus } from "@/lib/api-client/types/abandonment.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const status = (over: Partial<IngestionStatus> = {}): IngestionStatus => ({
  period: "today", timezone: "IST (UTC+05:30)", now: "2026-10-13T12:30:00.000Z",
  lastReceivedAt: "2026-10-13T12:27:00.000Z", lastProcessedAt: "2026-10-13T12:26:50.000Z", lastFailedAt: "2026-10-13T11:00:00.000Z", secondsSinceLastReceived: 180,
  received: { events: 377, distinctCarts: 343 }, byStatus: { processed: 176, ignoredNoContact: 0, failed: 201, pending: 3 }, failed: { retryable: 51, exhausted: 150 }, processedAfterRetry: 9,
  carts: { received: 343, saved: 163, notSaved: 180, ignoredNoContact: 0 },
  latency: { providerToReceipt: { samples: 370, p50: 66, p90: 84, max: 121 }, receiptToSaved: { samples: 176, p50: 4.4, p90: 5, max: 9.3 } },
  backlog: { pending: 3, retryable: 51, exhausted7d: 150, oldestPendingAgeSeconds: 240 },
  process: { since: "2026-10-13T06:00:00.000Z", received: 40, duplicates: 4, unauthorized: 1, invalidBody: 0, notConfigured: 0, unusableNoContact: 2, processed: 30, failedAttempts: 3, exhausted: 0, autoAssignFailed: 1, recoveredByReconcile: 0 },
  lastReconcile: null, ...over,
});
const view = (s: IngestionStatus, o: { canReconcile?: boolean } = {}) => renderToStaticMarkup(<IngestionHealthView status={s} canReconcile={o.canReconcile ?? false} />);
const v = (h: string, id: string) => text(new RegExp(`data-testid="${id}-value"[^>]*>([^<]*)<`).exec(h)?.[1] ?? "?");

describe("ingestion health", () => {
  it("shows received / saved / NOT saved / failed / pending and the retry breakdown", () => {
    const h = view(status());
    assert.deepEqual(["ing-events", "ing-carts", "ing-saved", "ing-notsaved", "ing-failed", "ing-pending", "ing-retried"].map((id) => v(h, id)), ["377", "343", "163", "180", "201", "3", "9"]);
    assert.match(text(h), /51 retrying · 150 dead/);
  });

  it("states the delay from Fastrr to the CRM separately from the CRM's own processing time, and when the last event arrived", () => {
    const t = text(view(status()));
    assert.match(t, /Fastrr → CRM receipt: p50 66 s · p90 84 s · max 2 min/);
    assert.match(t, /CRM receipt → saved: p50 4.4 s · p90 5 s · max 9.3 s/);
    assert.match(t, /Last event received .* IST \(3 min ago\)/);
  });

  it("raises a clear alert when carts were received but not saved, and offers re-processing to an admin only", () => {
    const admin = view(status(), { canReconcile: true });
    assert.match(admin, /data-testid="ing-alert"/);
    assert.match(text(admin), /180 carts were received from Fastrr but not saved as leads/);
    assert.match(admin, /data-testid="ing-reconcile"/);
    const other = view(status(), { canReconcile: false });
    assert.doesNotMatch(other, /data-testid="ing-reconcile"/);
    assert.match(text(other), /Ask an admin to re-process them/);
  });

  it("no alert when everything is saved", () => {
    const h = view(status({ carts: { received: 10, saved: 10, notSaved: 0, ignoredNoContact: 0 }, failed: { retryable: 0, exhausted: 0 }, byStatus: { processed: 10, ignoredNoContact: 0, failed: 0, pending: 0 } }));
    assert.doesNotMatch(h, /data-testid="ing-alert"/);
  });

  it("labels the in-memory counters as 'since this server started', and shows the last re-process result", () => {
    const t = text(view(status({ lastReconcile: { at: "2026-10-13T12:00:00.000Z", examined: 50, recovered: 48, failedAgain: 2, skipped: 0 } })));
    assert.match(t, /Since this server started/);
    assert.match(t, /resets on a restart/);
    assert.match(t, /Duplicates ignored 4/);
    assert.match(t, /48 recovered, 2 failed again, 50 examined/);
  });

  it("contains no customer data fields (counts and times only)", () => {
    const h = view(status());
    assert.doesNotMatch(h, /phone|email|address|secret|cart_id/i);
  });

  it("'ago' reads naturally", () => {
    assert.equal(ago(null), "no events yet");
    assert.equal(ago(30), "30 s ago");
    assert.equal(ago(600), "10 min ago");
    assert.equal(ago(7200), "2 h ago");
  });
});
