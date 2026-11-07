// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/lead-export-panels.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadSelectionToolbar } from "@/components/leads/lead-selection-toolbar";
import { ExportCard, exportScope } from "./export-shared";
import { LeadExcelPanel, excelRequestFilters } from "./lead-excel-panel";
import { RecordingZipPanel } from "./recording-zip-panel";
import type { RecordingExport } from "@/lib/api-client/endpoints/abandonment.recordings.api";

const job = (over: Partial<RecordingExport> = {}): RecordingExport => ({
  id: "j1", kind: "EXCEL", status: "COMPLETED", from: "2026-11-07", to: "2026-11-07", total: 12, processed: 12, failed: 0, remaining: 0, percent: 100, duplicates: 0, sizeBytes: 52_000, fileName: "leads.xlsx",
  errorMessage: null, createdAt: "2026-11-07T04:30:00.000Z", finishedAt: "2026-11-07T04:31:00.000Z", expiresAt: "2026-11-08T04:30:00.000Z", canDownload: true, stalled: false, attempts: 0, canRetry: false, selection: null, selectedCount: null, filtered: false, ...over,
});
const card = (j: RecordingExport) => renderToStaticMarkup(<ExportCard job={j} onRetry={() => undefined} onDownload={() => undefined} retrying={false} downloading={false} />);
const withClient = (node: React.ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe("selection toolbar - Download Leads", () => {
  const toolbar = (props: Partial<React.ComponentProps<typeof LeadSelectionToolbar>>) =>
    renderToStaticMarkup(<LeadSelectionToolbar count={20} onClear={() => undefined} {...props} />);

  it("shows Download Leads right beside Assign Manager when downloading is allowed", () => {
    const html = toolbar({ onAssignManager: () => undefined, onDownload: () => undefined, onAssignSalesperson: () => undefined });
    const manager = html.indexOf("Assign Manager");
    const download = html.indexOf("Download Leads");
    const salesperson = html.indexOf("Assign Salesperson");
    assert.ok(manager > -1 && download > manager && download < salesperson, "order: Assign Manager, Download Leads, Assign Salesperson");
    assert.match(html, /20<\/span><span class="font-semibold">leads selected/);
  });

  it("is absent when the viewer may not export (no handler), and disabled while it starts", () => {
    assert.doesNotMatch(toolbar({ onAssignManager: () => undefined }), /Download Leads/);
    const busy = toolbar({ onDownload: () => undefined, downloading: true });
    assert.match(busy, /disabled=""[^>]*data-testid="download-leads"|data-testid="download-leads"[^>]*disabled=""/);
    assert.match(busy, /Starting…/);
  });
});

describe("export card", () => {
  it("shows type, scope, status, progress, every count and the dates", () => {
    const html = card(job({ kind: "ZIP", total: 200, processed: 150, failed: 10, remaining: 40, percent: 80, status: "PROCESSING", canDownload: false }));
    assert.match(html, /data-kind="ZIP"/);
    assert.match(html, />Processing</);
    assert.match(html, /80%/);
    assert.match(html, /Total recordings: <\/dt><dd[^>]*>200/);
    assert.match(html, /Successful: <\/dt><dd[^>]*>150/);
    assert.match(html, /Failed \/ unavailable: <\/dt><dd[^>]*>10/);
    assert.match(html, /Remaining: <\/dt><dd[^>]*>40/);
    assert.match(html, /Started /);
    assert.doesNotMatch(html, /Download ZIP/);
  });

  it("a finished Excel offers its download, and a failed one explains why and offers Retry", () => {
    const done = card(job());
    assert.match(done, /Download Excel \(51 KB\)/);
    assert.match(done, /Completed/);
    const failed = card(job({ status: "FAILED", canDownload: false, canRetry: true, errorMessage: "The export was interrupted 5 times and gave up: database unavailable" }));
    assert.match(failed, /Retry export/);
    assert.match(failed, /database unavailable/);
    assert.doesNotMatch(failed, /export-download/);
  });

  it("names what an export covers: the ticked leads, every matching lead, or the date range", () => {
    assert.equal(exportScope(job({ selection: "IDS", selectedCount: 7 })), "Selected leads (7)");
    assert.equal(exportScope(job({ selection: "MATCHING" })), "All matching leads");
    assert.equal(exportScope(job()), "2026-11-07");
    assert.equal(exportScope(job({ from: "2026-11-01", to: "2026-11-07" })), "2026-11-01 → 2026-11-07");
    assert.equal(exportScope(job({ filtered: true })), "2026-11-07 · filtered");
    assert.match(card(job({ selection: "IDS", selectedCount: 7 })), /Selected leads \(7\)/);
  });

  it("tells the user when a running export has stalled (and that it is resumed by itself)", () => {
    assert.match(card(job({ status: "PROCESSING", stalled: true, canDownload: false })), /picked up again automatically/);
  });
});

describe("lead Excel and recording ZIP downloads are separate sections", () => {
  const excel = withClient(<LeadExcelPanel filters={{ workingStatus: "INTERESTED" }} />);
  const zip = withClient(<RecordingZipPanel />);

  it("the lead panel only offers Excel; the recording panel only offers ZIP", () => {
    assert.match(excel, /data-testid="lead-excel-panel"/);
    assert.match(excel, /Download abandoned leads \(Excel\)/);
    assert.match(excel, /data-testid="download-excel"/);
    assert.doesNotMatch(excel, /data-testid="download-zip"|call recordings \(ZIP\)/);
    assert.match(zip, /data-testid="recording-zip-panel"/);
    assert.match(zip, /Download call recordings \(ZIP\)/);
    assert.match(zip, /data-testid="download-zip"/);
    assert.doesNotMatch(zip, /data-testid="download-excel"|abandoned leads \(Excel\)/);
  });

  it("each has its own date range, so changing one cannot affect the other", () => {
    assert.match(excel, /id="lead-excel-from"/);
    assert.match(excel, /id="lead-excel-to"/);
    assert.match(zip, /id="recording-zip-from"/);
    assert.match(zip, /id="recording-zip-to"/);
    assert.doesNotMatch(excel, /recording-zip-/);
    assert.doesNotMatch(zip, /lead-excel-/);
  });

  it("each keeps its own history, and the list filters can be applied to the Excel only", () => {
    assert.match(excel, /export-history-excel/);
    assert.match(zip, /export-history-zip/);
    assert.match(excel, /Apply the 1 active list filter to this Excel file/);
    assert.doesNotMatch(zip, /active list filter/);
  });
});

describe("lead Excel: choose a salesperson and a lead status", () => {
  const html = withClient(<LeadExcelPanel />);

  it("offers a Salesperson choice and every lead status (New, Ringing, Interested, ...)", () => {
    assert.match(html, /for="lead-excel-salesperson"[^>]*>Salesperson</);
    assert.match(html, /<option value=""[^>]*>All salespeople<\/option>/);
    assert.match(html, /for="lead-excel-status"[^>]*>Lead status</);
    assert.match(html, /<option value=""[^>]*>All statuses<\/option>/);
    for (const [value, label] of [["NEW", "New"], ["RINGING", "Ringing"], ["CALL_BACK", "Call back"], ["INTERESTED", "Interested"], ["CONVERTED", "Converted"]]) {
      assert.match(html, new RegExp(`<option value="${value}">${label}</option>`));
    }
  });

  it("sends the chosen salesperson and status, which win over the list's own filters; empty choices send nothing", () => {
    assert.deepEqual(excelRequestFilters({}, true, "", ""), {});
    assert.deepEqual(excelRequestFilters({}, true, "sp-1", "RINGING"), { salespersonId: "sp-1", workingStatus: "RINGING" });
    assert.deepEqual(excelRequestFilters({ search: "paan", workingStatus: "NEW", valueMin: 100, lead: undefined, contact: "" }, true, "sp-1", "RINGING"), { search: "paan", workingStatus: "RINGING", valueMin: 100, salespersonId: "sp-1" });
    assert.deepEqual(excelRequestFilters({ search: "paan" }, false, "sp-1", ""), { salespersonId: "sp-1" }, "list filters are left out when the box is unticked");
  });
});
