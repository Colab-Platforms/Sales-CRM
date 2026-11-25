import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { LeadWorkingStatus } from "../../../../generated/prisma/enums.js";
import { detectColumns, readCustomer } from "./import.columns.js";
import { readRows, uniqueHeaders } from "./import.file.js";
import { buildImportData } from "./import.runner.js";
import { statusFromRow, statusFromTag, taggingColumn, taggingTally } from "./import.tagging.js";

/** The header row of the distributor file, trailing spaces included. */
const DISTRIBUTOR_HEADER = ["Timestamp", "Name", "Shop Name", "Mobile", "WhatsApp ", "lead source", "Shop Kind", "State", "City", "Tagging ", "Feedback"];

describe("lead status from the Tagging column", () => {
  it("maps every value found in the distributor file, as written there", () => {
    const expected: [string, LeadWorkingStatus][] = [
      ["Ringing ", "RINGING"],
      ["Intrested ", "INTERESTED"],
      ["Busy ", "BUSY"],
      ["Not intersted ", "NOT_INTERESTED"],
      ["not intersted ", "NOT_INTERESTED"],
      ["Converted ", "CONVERTED"],
      ["Switch off ", "SWITCHED_OFF"],
      ["Switch off", "SWITCHED_OFF"],
      ["Follow up", "FOLLOW_UP"],
      ["follow up", "FOLLOW_UP"],
      ["Call back ", "CALL_BACK"],
      ["Not rechable ", "NOT_REACHABLE"],
    ];
    for (const [value, status] of expected) assert.equal(statusFromTag(value), status, JSON.stringify(value));
  });

  it("handles spelling, capitals, spaces, hyphens and underscores", () => {
    const variations: Partial<Record<LeadWorkingStatus, string[]>> = {
      NEW: ["New", " NEW "],
      RINGING: ["ringing", "RINGING", "  Ringing\t"],
      BUSY: ["busy", "BUSY"],
      INTERESTED: ["Interested", "intrested", "INTRESTED"],
      NOT_INTERESTED: ["Not Interested", "NOT_INTERESTED", "Not  intersted", "not-interested", "NotIntrested"],
      SWITCHED_OFF: ["Switched off", "switch-off", "SWITCHOFF", "SWITCHED_OFF"],
      FOLLOW_UP: ["Follow-up", "FollowUp", "FOLLOW_UP", "follow  up"],
      CALL_BACK: ["Callback", "CALL BACK", "call_back"],
      NOT_REACHABLE: ["Not Reachable", "NOT_REACHABLE", "not rechable"],
      CONVERTED: ["converted", "CONVERTED"],
      DND: ["DND", "dnd", "D.N.D"],
    };
    for (const [status, values] of Object.entries(variations)) for (const value of values!) assert.equal(statusFromTag(value), status, JSON.stringify(value));
  });

  it("blank values set nothing", () => {
    for (const value of ["", "   ", "\t"]) assert.equal(statusFromTag(value), null);
    assert.equal(statusFromRow({ Mobile: "9876543210" }), null, "an empty cell is simply absent from the staged row");
  });

  it("unknown values set nothing: no guessing, and no system-only statuses", () => {
    for (const value of ["Member busy ", "Maybe later", "Interest", "Not", "Off", "Ringing / Busy", "-", "123", "Assigned", "Deactivated", "constructor", "__proto__", "toString"]) {
      assert.equal(statusFromTag(value), null, JSON.stringify(value));
    }
  });

  it("Tagging always wins over Feedback and every other column; Feedback is never a fallback", () => {
    const row = (tagging: string, feedback: string) => ({ Mobile: "9876543210", Tagging: tagging, Feedback: feedback, "Shop Kind": "Converted", status: "Converted" });
    assert.equal(statusFromRow(row("Busy", "Not interested")), "BUSY");
    assert.equal(statusFromRow(row("Intrested", "Switch off")), "INTERESTED");
    assert.equal(statusFromRow(row("", "Interested")), null);
    assert.equal(statusFromRow(row("Member busy", "Interested")), null);
    assert.equal(statusFromRow({ Mobile: "9876543210", Feedback: "Interested", Status: "Busy", Tag: "Busy", Remarks: "Ringing" }), null, "a file with no Tagging column gets no status");
  });

  it("finds the column by its own name only", () => {
    assert.equal(taggingColumn(uniqueHeaders(DISTRIBUTOR_HEADER)), "Tagging");
    assert.equal(taggingColumn(["TAGGING"]), "TAGGING");
    assert.equal(taggingColumn(["Tagging", "Tagging (2)"]), "Tagging", "a repeated column is not used");
    assert.equal(taggingColumn(["Feedback", "Tag", "Tags", "Status", "Tagging (2)"]), null);
  });

  it("counts recognised, blank and unrecognised values", () => {
    const tally = taggingTally("Tagging");
    for (const v of ["Busy", "busy ", "Ringing", "", undefined, null, "Member busy", "Member busy ", "Later"]) tally.add(v);
    tally.add("Intrested", 4);
    assert.deepEqual(tally.summary(), {
      column: "Tagging",
      recognized: 7,
      blank: 3,
      unrecognized: 3,
      statuses: [{ status: "INTERESTED", count: 4 }, { status: "BUSY", count: 2 }, { status: "RINGING", count: 1 }],
      unrecognizedValues: [{ value: "Member busy", count: 2 }, { value: "Later", count: 1 }],
    });
  });
});

describe("the distributor file's other columns map as before", () => {
  const headers = uniqueHeaders(DISTRIBUTOR_HEADER);

  it("keeps the same field for every column, with Tagging still kept as file data", () => {
    const detection = detectColumns(headers);
    assert.deepEqual(detection.mapping, {
      Timestamp: "extra", Name: "fullName", "Shop Name": "extra", Mobile: "mobile", WhatsApp: "extra", "lead source": "sourceName",
      "Shop Kind": "extra", State: "state", City: "city", Tagging: "extra", Feedback: "extra",
    });
    assert.deepEqual(detection.needsReview.map((c) => c.header), ["WhatsApp"]);
    assert.ok(!detection.unrecognized.some((c) => c.header === "Tagging"), "Tagging needs no choice");
    assert.ok(detection.unrecognized.some((c) => c.header === "Feedback"));
  });

  it("reads the same customer details, and keeps the Tagging and Feedback text on the lead exactly as written", () => {
    const cells = { Name: "Test Shop Owner", "Shop Name": "Test Stores", Mobile: "9876543210", "lead source": "Field visit", State: "MH", City: "Pune", Tagging: "Member busy", Feedback: "Interested" };
    const c = readCustomer(cells, detectColumns(headers).mapping);
    assert.deepEqual([c.firstName, c.lastName, c.mobile, c.sourceName, c.location, c.requirement], ["Test", "Shop Owner", "9876543210", "Field visit", "Pune, MH", null]);
    assert.deepEqual(buildImportData(c), { fields: { city: "Pune", state: "MH" }, extra: { "Shop Name": "Test Stores", Tagging: "Member busy", Feedback: "Interested" } });
  });

  it("works on rows read from a real .xlsx whose header has a trailing space", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lead-tagging-"));
    try {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet("distributors");
      sheet.addRow(DISTRIBUTOR_HEADER);
      sheet.addRow(["", "A One", "", 9876543210, "", "", "", "", "", "Intrested ", "Not interested"]);
      sheet.addRow(["", "B Two", "", 9876543211, "", "", "", "", "", "", "Interested"]);
      const file = join(dir, "d.xlsx");
      await book.xlsx.writeFile(file);
      let names: string[] | null = null;
      const statuses: (string | null)[] = [];
      for await (const r of readRows(file, "d.xlsx")) {
        if (!names) {
          names = uniqueHeaders(r.values);
          continue;
        }
        statuses.push(statusFromRow(Object.fromEntries(names.map((h, i) => [h, r.values[i] ?? ""]).filter(([, v]) => v !== ""))));
      }
      assert.deepEqual(statuses, ["INTERESTED", null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
