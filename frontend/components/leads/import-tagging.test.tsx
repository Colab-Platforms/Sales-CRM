// Frontend tests for the Tagging column in the lead import preview and summary.
// Run with: ../backend/node_modules/.bin/tsx --test components/leads/import-tagging.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewSummary, TaggingBreakdown } from "./import-leads-dialog";
import type { FileImportPreview, ImportTaggingSummary } from "@/lib/api-client/types/lead.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const tagging: ImportTaggingSummary = {
  column: "Tagging",
  recognized: 247,
  blank: 38,
  unrecognized: 1,
  statuses: [{ status: "RINGING", count: 78 }, { status: "INTERESTED", count: 68 }, { status: "NOT_INTERESTED", count: 24 }, { status: "SWITCHED_OFF", count: 7 }],
  unrecognizedValues: [{ value: "Member busy", count: 1 }],
};
const preview: FileImportPreview = { totalRows: 286, eligibleRows: 286, invalidRows: 0, newLeads: 286, missingPhone: 0, missingOrderCount: 286, invalidOrderCount: 0, classification: { repeat: 0, loyal: 0, vip: 0, unclassified: 286 }, problems: [] };

describe("Tagging in the import preview and summary", () => {
  it("shows the detected column, the statuses to be assigned and the three counts", () => {
    const t = text(renderToStaticMarkup(<PreviewSummary preview={{ ...preview, tagging }} segment={null} />));
    assert.match(t, /Lead status from the Tagging column/);
    for (const part of ["Recognised 247", "Blank 38", "Not recognised 1", "Ringing: 78", "Interested: 68", "Not interested: 24", "Switched off: 7"]) assert.ok(t.includes(part), part);
    assert.match(t, /Blank and unrecognised rows get the default status \(New\)/);
    assert.match(t, /Not recognised: "Member busy" \(1\)/);
  });
  it("after the import says what was assigned", () => {
    const html = renderToStaticMarkup(<TaggingBreakdown tagging={tagging} done />);
    assert.match(html, /aria-label="Statuses assigned"/);
    assert.match(text(html), /Blank and unrecognised rows got the default status/);
  });
  it("shows nothing extra for a file without a Tagging column, or an older server reply", () => {
    for (const p of [preview, { ...preview, tagging: null }]) assert.ok(!renderToStaticMarkup(<PreviewSummary preview={p} segment={null} />).includes("import-tagging"));
  });
  it("says nothing about defaults or unknown values when every value was recognised", () => {
    const t = text(renderToStaticMarkup(<TaggingBreakdown tagging={{ ...tagging, blank: 0, unrecognized: 0, unrecognizedValues: [] }} />));
    assert.ok(!t.includes("default status") && !t.includes("Not recognised:"));
  });
});
