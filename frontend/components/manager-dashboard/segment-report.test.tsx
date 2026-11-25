// Frontend tests for the Reports Segment filter and the segment lead report.
// Run with: ../backend/node_modules/.bin/tsx --test components/manager-dashboard/segment-report.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SegmentSelect } from "./filters";
import { historyEntries, SegmentLeadTable, SegmentMetrics } from "./segment-report";
import { analyticsParams } from "@/lib/api-client/endpoints/manager.api";
import { defaultFilters, filtersFromSearch, filtersToSearch, toQuery } from "@/lib/manager-analytics";
import type { SegmentLeadHistory, SegmentReport } from "@/lib/api-client/types/segment-report.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Segment dropdown", () => {
  it("lists All Segments plus exactly the segments the API returned, built-in and custom (nothing hardcoded)", () => {
    const html = renderToStaticMarkup(<SegmentSelect value="" onChange={() => {}} segments={[{ id: "a", name: "VIP Customers" }, { id: "b", name: "My Own Campaign" }]} />);
    assert.deepEqual([...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ["All Segments", "VIP Customers", "My Own Campaign"]);
    const empty = renderToStaticMarkup(<SegmentSelect value="" onChange={() => {}} segments={[]} />);
    assert.deepEqual([...empty.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ["All Segments"]);
  });
});

describe("Segment filter state", () => {
  it("All Segments is the default and sends no segment parameter, so the report requests are as before", () => {
    const q = toQuery(defaultFilters());
    assert.equal(q.segmentId, undefined);
    assert.ok(!("segmentId" in analyticsParams(q)));
    assert.ok(!filtersToSearch(defaultFilters()).includes("segment"));
  });
  it("a chosen segment travels with every other filter to the API", () => {
    const f = { ...defaultFilters(), segmentId: "seg-1", salespersonId: "sp-1", paymentMode: "COD" as const, orderStatus: "DELIVERED" as const, callStatus: "CONNECTED" as const };
    const p = analyticsParams(toQuery(f)) as Record<string, unknown>;
    assert.deepEqual([p.segmentId, p.salespersonId, p.paymentMode, p.orderStatus, p.callStatus], ["seg-1", "sp-1", "COD", "DELIVERED", "CONNECTED"]);
    assert.equal(filtersFromSearch(new URLSearchParams(filtersToSearch(f))).segmentId, "seg-1");
  });
  it("Reset (the default filters) clears the segment along with the others", () => {
    const fresh = defaultFilters();
    assert.deepEqual([fresh.segmentId, fresh.salespersonId, fresh.paymentMode, fresh.orderStatus, fresh.callStatus], ["", "", "ALL", "ALL", "ALL"]);
  });
});

const metrics: SegmentReport["metrics"] = { totalLeads: 196, contacted: 120, pending: 76, converted: 30, lost: 12, addedInPeriod: 3, calls: 41, connectedCalls: 17, followUpsCompleted: 5, followUpsPending: 9, followUpsOverdue: 4, activities: 88, notes: 11, statusChanges: 22, assignments: 33, activityByType: [{ type: "STATUS_CHANGE", count: 22 }] };

describe("segment metrics and lead list", () => {
  it("shows every metric", () => {
    const t = text(renderToStaticMarkup(<SegmentMetrics metrics={metrics} />));
    for (const part of ["Total leads 196", "Contacted 120", "Pending 76", "Converted 30", "Lost 12", "Calls 41", "Follow-ups completed 5", "Follow-ups pending 9", "4 overdue", "Recorded activities 88", "Status change 22"]) assert.ok(t.includes(part), part);
    assert.ok(!/revenue|order/i.test(t), "no sales figures among lead metrics");
    for (const definition of ["every lead that is not Pending (includes Converted and Lost)", "status New or Assigned, never called or marked contacted (any date)", "current status Converted", "current status Not Interested or DND"]) assert.ok(t.includes(definition), definition);
  });
  it("lists name, phone, salesperson, status and activity counts, with a link to the lead and a history button", () => {
    const html = renderToStaticMarkup(
      <SegmentLeadTable onHistory={() => {}} leads={[{ id: "l1", leadNumber: "LD-1", name: "Asha K", phone: "9800000000", email: null, location: null, salesperson: null, manager: null, source: "Facebook", status: "CALL_BACK", priority: "HIGH", stage: "CUSTOMER", createdAt: "2026-11-01T00:00:00Z", lastContactedAt: null, lastActivityAt: null, calls: 2, connectedCalls: 1, activities: 4, notes: 1, followUpsCompleted: 1, followUpsPending: 2 }]} />,
    );
    const t = text(html);
    for (const part of ["Asha K", "9800000000", "Unassigned", "Call back", "Facebook", "Customer", "1 / 2"]) assert.ok(t.includes(part), part);
    assert.match(html, /href="\/dashboard\/leads\/l1"/);
    assert.match(html, /aria-label="Activity history of Asha K"/);
    assert.match(text(renderToStaticMarkup(<SegmentLeadTable leads={[]} onHistory={() => {}} />)), /No leads in this segment match/);
  });
  it("merges calls, follow-ups and activities into one history, newest first", () => {
    const h: SegmentLeadHistory = {
      lead: { id: "l1", leadNumber: "LD-1", name: "Asha", phone: null, status: "NEW", salesperson: null },
      calls: [{ id: "c", status: "NO_ANSWER", direction: "OUTBOUND", durationSeconds: null, notes: "try later", startedAt: "2026-11-02T00:00:00Z", createdAt: "2026-11-02T00:00:00Z", by: "Priti", outcome: null }],
      tasks: [{ id: "t", type: "CALLBACK", status: "PENDING", title: "Call back", description: null, scheduledAt: "2026-11-03T00:00:00Z", completedAt: null, createdAt: "2026-11-01T00:00:00Z", assignedTo: "Priti" }],
      activities: [{ id: "a", type: "NOTE", title: "Note added", description: "likes it", createdAt: "2026-11-01T00:00:00Z", by: null }],
      limit: 200,
    };
    assert.deepEqual(historyEntries(h).map((e) => e.kind), ["Callback", "Call", "Note"]);
  });
});
