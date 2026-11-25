// Frontend tests for the clickable segment metric cards and their inline detail records.
// Run with: ../backend/node_modules/.bin/tsx --test components/manager-dashboard/segment-drilldown.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SegmentMetrics, segmentTiles } from "./segment-report";
import { DRILL_TITLES, DrillContent, DrillTable, duration } from "./segment-drilldown";
import { apiClient } from "@/lib/api-client/client";
import { managerAnalyticsApi } from "@/lib/api-client/endpoints/manager.api";
import { defaultFilters, toQuery } from "@/lib/manager-analytics";
import type { SegmentDetails, SegmentDrillMetric, SegmentLeadRow, SegmentReport } from "@/lib/api-client/types/segment-report.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const metrics: SegmentReport["metrics"] = { totalLeads: 120, contacted: 31, pending: 89, converted: 0, lost: 2, addedInPeriod: 0, calls: 25, connectedCalls: 9, followUpsCompleted: 1, followUpsPending: 2, followUpsOverdue: 1, activities: 121, notes: 3, statusChanges: 20, assignments: 4, activityByType: [] };
const METRICS: SegmentDrillMetric[] = ["totalLeads", "contacted", "pending", "converted", "lost", "calls", "followUpsCompleted", "followUpsPending", "activities"];
const page = { page: 1, pageSize: 25, total: 1, totalPages: 1 };
const lead: SegmentLeadRow = { id: "l1", leadNumber: "LD-1", name: "Asha K", phone: "9800000000", email: null, location: null, salesperson: "Priti", manager: null, source: "Facebook", status: "CALL_BACK", priority: "HIGH", stage: "LEAD", createdAt: "2026-11-01T00:00:00Z", lastContactedAt: null, lastActivityAt: "2026-11-20T05:00:00Z", calls: 2, connectedCalls: 1, activities: 4, notes: 1, followUpsCompleted: 1, followUpsPending: 2 };
const ref = { id: "r1", leadId: "l1", leadNumber: "LD-1", leadName: "Asha K", phone: "9800000000" };

describe("metric cards are clickable", () => {
  it("every card is a button tied to its own metric, in the same order and with the value it shows", () => {
    assert.deepEqual(segmentTiles(metrics).map((t) => [t.key, t.value]), METRICS.map((m) => [m, metrics[m]]));
    const html = renderToStaticMarkup(<SegmentMetrics metrics={metrics} />);
    assert.equal((html.match(/<button type="button"/g) ?? []).length, 9);
    assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 9);
    assert.equal((text(html).match(/View details/g) ?? []).length, 9);
    assert.match(html, /cursor-pointer/);
    assert.match(html, /hover:border-primary/);
  });
  it("highlights only the selected card", () => {
    const html = renderToStaticMarkup(<SegmentMetrics metrics={metrics} selected="calls" />);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    const selected = html.match(/<button[^>]*aria-pressed="true"[^>]*>.*?<\/button>/)![0];
    assert.match(text(selected), /^Calls 25 .*Hide details/);
    assert.match(selected, /ring-2 ring-primary/);
    assert.match(selected, /aria-controls="segment-drilldown"/);
  });
  it("clicking a card selects it, clicking another replaces it, and clicking the selected one again closes it", () => {
    const picked: (SegmentDrillMetric | null)[] = [];
    const buttons = (selected: SegmentDrillMetric | null) => {
      const found: ReactElement<{ onClick: () => void }>[] = [];
      const walk = (node: ReactNode) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
        if (node.type === "button") found.push(node as ReactElement<{ onClick: () => void }>);
        else walk(node.props.children);
      };
      walk(SegmentMetrics({ metrics, selected, onSelect: (m) => picked.push(m) }));
      return found;
    };
    buttons(null)[5]!.props.onClick(); // Calls
    buttons("calls")[2]!.props.onClick(); // Pending replaces it
    buttons("pending")[2]!.props.onClick(); // Pending again: closed
    assert.deepEqual(picked, ["calls", "pending", null]);
  });
});

describe("detail tables show the columns of each kind of record", () => {
  const cases: { name: string; data: SegmentDetails; heads: string[]; values: string[] }[] = [
    ...(["totalLeads", "contacted", "pending", "converted", "lost"] as const).map((metric) => ({
      name: metric,
      data: { metric, kind: "leads" as const, rows: [lead], pagination: page },
      heads: ["Lead", "Phone", "Assigned salesperson", "Current status", "Source", "Last activity", "Last contacted", "Calls in period", "Activities in period", "Follow-ups done / pending"],
      values: ["Asha K", "9800000000", "Priti", "Call back", "Facebook", "20 Nov 2026", "1 / 2"],
    })),
    {
      name: "calls",
      data: { metric: "calls", kind: "calls", rows: [{ ...ref, agent: "Priti", at: "2026-11-20T05:00:00Z", direction: "OUTBOUND", status: "NO_ANSWER", outcome: "Call later", durationSeconds: 75, notes: null }], pagination: page },
      heads: ["Lead", "Phone", "Telecaller / salesperson", "Date and time", "Status / outcome", "Duration", "Notes"],
      values: ["Asha K", "9800000000", "Priti", "20 Nov 2026", "Outbound · No answer · Call later", "1m 15s"],
    },
    ...(["followUpsCompleted", "followUpsPending"] as const).map((metric) => ({
      name: metric,
      data: { metric, kind: "followUps" as const, rows: [{ ...ref, assignedTo: "Priti", type: "CALLBACK", status: "PENDING", title: "Call back", notes: "after 5pm", scheduledAt: "2026-11-20T05:00:00Z", completedAt: null, overdue: true }], pagination: page },
      heads: ["Lead", "Phone", "Assigned salesperson", "Follow-up date and time", "Status", "Notes"],
      values: ["Asha K", "Priti", "20 Nov 2026", "Pending", "Overdue", "Call back — after 5pm"],
    })),
    {
      name: "activities",
      data: { metric: "activities", kind: "activities", rows: [{ ...ref, type: "STATUS_CHANGE", title: "Status changed to RINGING", description: null, by: "Priti", at: "2026-11-20T05:00:00Z" }], pagination: page },
      heads: ["Lead", "Phone", "Activity type", "Description", "Performed by", "Date and time"],
      values: ["Asha K", "Status change", "Status changed to RINGING", "Priti", "20 Nov 2026"],
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const html = renderToStaticMarkup(<DrillTable data={c.data} />);
      assert.deepEqual([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), c.heads);
      for (const v of c.values) assert.ok(text(html).includes(v), v);
      assert.ok(!/<a\s|href=/.test(html), "the records stay inline: no links away from the report");
    });
  }
  it("missing values show a dash instead of invented data", () => {
    const t = text(renderToStaticMarkup(<DrillTable data={{ metric: "calls", kind: "calls", rows: [{ ...ref, phone: null, agent: null, at: "2026-11-20T05:00:00Z", direction: "OUTBOUND", status: "FAILED", outcome: null, durationSeconds: null, notes: null }], pagination: page }} />));
    assert.ok((t.match(/—/g) ?? []).length >= 4);
    assert.deepEqual([duration(null), duration(0), duration(59), duration(600)], ["—", "0s", "59s", "10m 00s"]);
  });
});

describe("loading, empty and error states", () => {
  const render = (props: Partial<Parameters<typeof DrillContent>[0]>) => renderToStaticMarkup(<DrillContent metric="calls" data={undefined} isPending={false} error={null} onRetry={() => {}} {...props} />);
  it("loading", () => assert.match(render({ isPending: true }), /role="status" aria-label="Loading records"/));
  it("empty: each card has its own message", () => {
    for (const metric of METRICS) {
      const t = text(render({ metric, data: { metric, kind: "leads", rows: [], pagination: { ...page, total: 0 } } as SegmentDetails }));
      assert.equal(t, DRILL_TITLES[metric].empty.replace(/“/g, "“"));
    }
  });
  it("error: an alert with a retry, never an empty table", () => {
    const html = render({ error: new Error("boom") });
    assert.match(html, /role="alert"/);
    assert.match(text(html), /Failed to load calls\..*Try again/);
  });
  it("a failed refresh keeps the earlier records but says they may be out of date", () => {
    const html = render({ metric: "totalLeads", data: { metric: "totalLeads", kind: "leads", rows: [lead], pagination: page }, error: new Error("boom") });
    assert.match(html, /role="alert"/);
    assert.match(text(html), /Could not refresh these records.*Try again.*Asha K/);
  });
});

describe("requests carry the card and every applied filter", () => {
  it("page of records and its export go to the details endpoints with the segment, dates, salesperson and call filter", async () => {
    const seen: { url?: string; params?: Record<string, unknown> }[] = [];
    const original = apiClient.get;
    apiClient.get = (async (url: string, config: { params: Record<string, unknown> }) => {
      seen.push({ url, params: config.params });
      return { data: { data: {} } };
    }) as typeof apiClient.get;
    try {
      const q = toQuery({ ...defaultFilters(), segmentId: "seg-1", salespersonId: "sp-1", callStatus: "CONNECTED" });
      await managerAnalyticsApi.segmentDetails(q, "calls", 3, 25);
      await managerAnalyticsApi.segmentDetailsXlsx(q, "followUpsPending");
    } finally {
      apiClient.get = original;
    }
    assert.deepEqual(seen.map((s) => s.url), ["/manager/analytics/segment/details", "/manager/analytics/segment/details/export.xlsx"]);
    for (const s of seen) assert.deepEqual([s.params!.segmentId, s.params!.salespersonId, s.params!.callStatus, Boolean(s.params!.from), Boolean(s.params!.to)], ["seg-1", "sp-1", "CONNECTED", true, true]);
    assert.deepEqual([seen[0]!.params!.metric, seen[0]!.params!.page, seen[0]!.params!.pageSize, seen[1]!.params!.metric], ["calls", 3, 25, "followUpsPending"]);
  });
});
