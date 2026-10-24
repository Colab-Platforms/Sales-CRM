// Pure tests (no database, no WhatsApp): time-zone day boundaries, report aggregation / team totals, the message text and the one-line template form, and input validation. All sources are fakes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { Role } from "../../../generated/prisma/enums.js";
import { buildReportXlsx, reportFilename } from "./report-automation.xlsx.js";
import { resolvePeriod, isValidDateString, buildReportData, dayBounds, formatReportText, safeName, isValidTimezone, localParts, normalizeOptions, parseSendTime, reportDateFor, shiftDate, toTemplateParam, fitDetailText, DETAIL_TEXT_MAX, NOTIFICATION_MAX, tzOffsetMinutes, type ReportSources } from "./report-automation.report.js";
import { normalizeRecipient, validateConfigInput, validateTestSendBody, validatePreviewQuery } from "./report-automation.validators.js";

const IST = "Asia/Kolkata";

describe("IST day boundaries", () => {
  it("IST is UTC+05:30 all year and a day is [00:00 IST, next 00:00 IST)", () => {
    assert.equal(tzOffsetMinutes(new Date("2026-10-23T10:00:00Z"), IST), 330);
    const { start, end, offsetMinutes } = dayBounds("2026-10-23", IST);
    assert.equal(start.toISOString(), "2026-10-22T18:30:00.000Z");
    assert.equal(end.toISOString(), "2026-10-23T18:30:00.000Z");
    assert.equal(offsetMinutes, 330);
  });
  it("the local date flips exactly at 00:00 IST (18:30 UTC), not at UTC midnight", () => {
    assert.deepEqual(localParts(new Date("2026-10-22T18:29:00Z"), IST), { date: "2026-10-22", minutes: 23 * 60 + 59 });
    assert.deepEqual(localParts(new Date("2026-10-22T18:30:00Z"), IST), { date: "2026-10-23", minutes: 0 });
    assert.equal(localParts(new Date("2026-10-23T00:10:00Z"), IST).date, "2026-10-23");
  });
  it("TODAY / YESTERDAY pick the right local day, and shiftDate crosses month and year ends", () => {
    const now = new Date("2026-10-23T16:00:00Z"); // 21:30 IST on the 23rd
    assert.equal(reportDateFor(now, IST, "TODAY"), "2026-10-23");
    assert.equal(reportDateFor(now, IST, "YESTERDAY"), "2026-10-22");
    assert.equal(reportDateFor(new Date("2026-10-23T19:00:00Z"), IST, "TODAY"), "2026-10-24"); // 00:30 IST next day
    assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
  });
  it("a zone with daylight saving uses the offset in force on that day; unknown zones are refused", () => {
    assert.equal(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z"), "America/New_York"), -240);
    assert.equal(tzOffsetMinutes(new Date("2026-12-01T12:00:00Z"), "America/New_York"), -300);
    assert.equal(dayBounds("2026-07-01", "America/New_York").start.toISOString(), "2026-07-01T04:00:00.000Z");
    assert.ok(isValidTimezone(IST) && !isValidTimezone("Mars/Olympus") && !isValidTimezone("IST"));
  });
  it("send times parse as minutes since midnight and bad ones throw", () => {
    assert.equal(parseSendTime("21:00"), 1260);
    assert.equal(parseSendTime("00:05"), 5);
    for (const bad of ["24:00", "9:00", "21:60", "", "ab:cd"]) assert.throws(() => parseSendTime(bad), /Invalid/);
  });
});

const row = (id: string, name: string, o: Partial<Record<string, number>> = {}) => ({ id, name, leads: 0, contacted: 0, interested: 0, converted: 0, calls: 0, connected: 0, talkTimeSec: 0, orders: 0, revenue: 0, ...o }) as never;
const sources = (rows: unknown[], cancelled: [string, number][] = [], follow: [string, number][] = []): ReportSources & { seen: { date?: string; from?: string; offset?: number; end?: Date } } => {
  const seen: { date?: string; from?: string; offset?: number; end?: Date } = {};
  return {
    seen,
    overview: async (_v, from, to, offset) => { seen.date = to; seen.from = from; seen.offset = offset; return rows as never; },
    cancelledByUser: async (_ids, _s, e) => { seen.end = e; return new Map(cancelled); },
    pendingFollowUps: async () => new Map(follow),
  };
};
const viewer = { id: "m1", role: Role.MANAGER };

describe("report aggregation", () => {
  it("team totals are the sums of the telecallers, conversion is converted / leads, and each figure comes from the stated source", async () => {
    const src = sources(
      [row("a", "Asha", { leads: 10, contacted: 8, interested: 4, converted: 2, calls: 30, connected: 20, talkTimeSec: 3600, orders: 2, revenue: 1298 }), row("b", "Bala", { leads: 5, converted: 0, calls: 10, connected: 4, talkTimeSec: 600, orders: 1, revenue: 649 })],
      [["a", 1]],
      [["a", 3], ["b", 2]],
    );
    const data = await buildReportData(viewer, "2026-10-23", IST, src);
    assert.equal(src.seen.date, "2026-10-23");
    assert.equal(src.seen.offset, 330);
    assert.equal(src.seen.end?.toISOString(), "2026-10-23T18:30:00.000Z", "the cancelled-orders query is bounded by the local day's end");
    assert.deepEqual(data.team, { telecallers: 2, leads: 15, contacted: 8, interested: 4, converted: 2, conversionPct: 13.3, calls: 40, connected: 24, talkTimeSec: 4200, orders: 3, revenue: 1947, cancelledOrders: 1, pendingFollowUps: 5 });
    const asha = data.people.find((p) => p.id === "a")!;
    assert.deepEqual([asha.conversionPct, asha.cancelledOrders, asha.pendingFollowUps], [20, 1, 3]);
    assert.equal(data.people.find((p) => p.id === "b")!.conversionPct, 0);
  });
  it("conversion is left out (null) when no lead was handed over that day - never a made-up 0% or a division by zero", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources([row("a", "Asha", { calls: 3 })]));
    assert.equal(data.people[0]!.conversionPct, null);
    assert.equal(data.team.conversionPct, null);
    assert.ok(!formatReportText(data, normalizeOptions({})).includes("NaN"));
    assert.ok(!formatReportText(data, normalizeOptions({})).includes("(null%)"));
  });
  it("an empty scope gives an honest empty report", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources([]));
    assert.deepEqual([data.people.length, data.team.telecallers], [0, 0]);
    assert.match(formatReportText(data, normalizeOptions({})), /No active telecallers/);
  });
});

describe("message text", () => {
  const people = [row("a", "Asha", { leads: 10, converted: 2, calls: 30, connected: 20, talkTimeSec: 3720, orders: 2, revenue: 1298 }), row("b", "Bala", { leads: 5 })];
  it("uses the structured layout: branded title, date, timezone, TEAM OVERVIEW one metric per line, then a block per telecaller", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(people, [], [["a", 3]]));
    const text = formatReportText(data, normalizeOptions({}));
    assert.match(text, /^\*AYUSHWELLNESS \| DAILY TEAM REPORT\*\nDate: 23 Oct 2026\nTimezone: Asia\/Kolkata\n\n\*TEAM OVERVIEW\*\nOrders: 2\nRevenue: ₹1,298\nCancelled orders: 0\nLeads handled: 15\nConverted: 2 \(13\.3%\)\nCalls: 30\nConnected calls: 20\nTalk time: 1h 2m\nPending follow-ups: 3\n\n\*TELECALLER PERFORMANCE\*\n\n\*Asha\*\nOrders: 2 \| Revenue: ₹1,298\nCancelled orders: 0\nLeads: 10 \| Converted: 2 \(20%\)\nCalls: 30 \| Connected: 20\nTalk time: 1h 2m\nPending follow-ups: 3\n\n\*Bala\*/);
    assert.ok(!/webinar|feedback/i.test(text));
  });
  it("a telecaller name cannot break the formatting: markup characters and control characters are removed, long names are cut, an empty name is labelled", async () => {
    assert.equal(safeName("*Evil*_name~`\n\tX"), "Evilname X");
    assert.equal(safeName("   "), "Unnamed");
    assert.equal(safeName("a".repeat(100)).length, 60);
    const data = await buildReportData(viewer, "2026-10-23", IST, sources([row("a", "*Bold*\nINJECT", { leads: 0 })]));
    const text = formatReportText(data, normalizeOptions({}));
    assert.ok(text.includes("\n*BoldINJECT*\n") || text.includes("*Bold INJECT*"));
    assert.match(text, /Leads: 0 \| Converted: 0\n/, "a zero denominator gives no percentage, never NaN or Infinity");
    assert.ok(!/NaN|Infinity/.test(text));
  });
  it("only the chosen metric groups appear", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(people));
    const text = formatReportText(data, normalizeOptions({ teamSummary: false, calls: false, leads: false, sales: true, followUps: false }));
    assert.ok(!/Calls|Leads|Follow-ups|TEAM OVERVIEW/.test(text));
    assert.match(text, /Orders/);
  });
  it("the template NOTIFICATION is one short headline (no line breaks, no || blocks) saying whether the details follow; the readable report is the separate multi-line text", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(people, [], [["a", 3]]));
    const open = toTemplateParam(data, normalizeOptions({}), true).text;
    assert.ok(!/[\n\r\t]/.test(open) && !/ {2}/.test(open) && !/\|\|?/.test(open), "no flattened | or || report");
    assert.ok(open.length <= NOTIFICATION_MAX);
    assert.match(open, /^Team report for 23 Oct 2026 \(Asia\/Kolkata\): Orders 2, Revenue ₹1,298, Leads 15, Converted 2 \(13\.3%\), Calls 30, Pending follow-ups 3\. The full report and the Excel file follow/);
    const closed = toTemplateParam(data, normalizeOptions({}), false).text;
    assert.match(closed, /24-hour window for this number is closed: reply to this number to receive them\.$/);
    assert.ok(!/webinar|feedback/i.test(open + closed));
    assert.match(toTemplateParam(data, normalizeOptions({ teamSummary: true, calls: false, leads: false, sales: true, followUps: false }), true).text, /Orders 2, Revenue ₹1,298\. The full/, "only the chosen groups");
  });
  it("the detailed text keeps every telecaller block whole and fits one WhatsApp message: with many telecallers it drops whole blocks and says how many are only in the Excel", async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`u${i}`, `Telecaller Number ${i}`, { leads: 12, converted: 3, calls: 44, connected: 30, talkTimeSec: 5000, orders: 4, revenue: 2596 }));
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(many));
    const big = fitDetailText(data, normalizeOptions({}));
    assert.ok(big.text.length <= DETAIL_TEXT_MAX);
    assert.equal(big.truncated, true);
    assert.ok(big.shown > 0 && big.shown < 60);
    assert.match(big.text, new RegExp(`\\+${60 - big.shown} more telecallers not shown - see the Excel report$`));
    assert.ok(big.text.split("\n\n").every((block) => !block.startsWith("*Telecaller Number") || /Pending follow-ups: \d+$|Pending follow-ups: \d+\n/.test(block + "\n")), "no block is cut in half");
    const small = fitDetailText(await buildReportData(viewer, "2026-10-23", IST, sources(people)), normalizeOptions({}));
    assert.deepEqual([small.truncated, small.shown], [false, 2]);
    assert.ok(!/more telecaller/.test(small.text));
  });
});

describe("input validation", () => {
  const ok = { enabled: true, recipient: "+91 98765-43210", sendTime: "21:00", timezone: IST, reportFor: "TODAY", templateName: "daily_team_report", languageCode: "en", options: { teamSummary: true, calls: true, leads: true, sales: true, followUps: true } };
  it("normalises a typed number to E.164 and accepts a complete config", () => {
    assert.equal(normalizeRecipient(" +91 (98765) 43210 "), "+919876543210");
    const r = validateConfigInput(ok);
    assert.ifError(r.error);
    assert.equal(r.value!.recipients[0]!.phone, "+919876543210");
  });
  it("refuses a recipient without a country code / too short / with letters, a bad time, an unknown timezone, no metric group, and enabling without recipient or template", () => {
    const bad = (patch: Record<string, unknown>) => validateConfigInput({ ...ok, ...patch }).error?.message ?? "";
    assert.match(bad({ recipient: "9876543210" }), /country code/);
    assert.match(bad({ recipient: "+91123" }), /country code/);
    assert.match(bad({ recipient: "+91abcdefghij" }), /country code/);
    assert.match(bad({ sendTime: "9pm" }), /HH:mm/);
    assert.match(bad({ sendTime: "25:00" }), /HH:mm/);
    assert.match(bad({ timezone: "Nowhere/City" }), /timezone/i);
    assert.match(bad({ options: { teamSummary: true, calls: false, leads: false, sales: false, followUps: false } }), /metric/i);
    assert.match(bad({ recipient: "" }), /at least one recipient/i);
    assert.match(bad({ templateName: "" }), /is required/i);
    assert.match(bad({ templateName: "webinar_feedback_form" }), /dedicated template/i);
    assert.ifError(validateConfigInput({ ...ok, enabled: false, recipient: "", templateName: "" }).error);
    assert.match(bad({ recipient: undefined, recipients: [{ phone: "+919876543210" }, { phone: "+91 98765 43210" }] }), /more than once/); // a disabled draft may be incomplete
  });
  it("a test send needs an explicit confirmation, and the preview date must be a real date", () => {
    assert.ok(validateTestSendBody({}).error);
    assert.ok(validateTestSendBody({ confirm: false }).error);
    assert.ifError(validateTestSendBody({ confirm: true }).error);
    assert.ifError(validatePreviewQuery({ date: "2026-10-23" }).error);
    assert.ok(validatePreviewQuery({ date: "2026-13-45" }).error);
    assert.ok(validatePreviewQuery({ date: "yesterday" }).error);
  });
});

describe("telecaller roster: only the chosen real telecallers are in the report", () => {
  const real = [row("r1", "Aayush Tiwari", { leads: 9, converted: 1, calls: 18, connected: 8, orders: 2, revenue: 1298 }), row("r2", "Aryan", { leads: 5, converted: 2, calls: 10, connected: 4, orders: 1, revenue: 499 })];
  const testing = [row("t1", "Test1", { leads: 100, converted: 50, calls: 500, connected: 400, talkTimeSec: 90000, orders: 30, revenue: 99999 }), row("t2", "test3", { leads: 7, orders: 5, revenue: 5000 })];
  const everyone = [...real, testing[0], real[1], testing[1]].filter((x, i, a) => a.indexOf(x) === i);
  const roster = ["r1", "r2"];

  it("totals, rows and the cancelled / follow-up lookups use ONLY the roster; an excluded user's numbers are dropped, not moved to anyone", async () => {
    const src = sources(everyone, [["r1", 1], ["t1", 9]], [["r1", 3], ["t1", 40]]);
    const seenIds: string[][] = [];
    const wrapped = { ...src, cancelledByUser: async (ids: string[], s: Date, e: Date) => { seenIds.push(ids); return src.cancelledByUser(ids, s, e); } };
    const data = await buildReportData(viewer, "2026-10-23", IST, wrapped, roster);
    assert.deepEqual(data.people.map((p) => p.name), ["Aayush Tiwari", "Aryan"]);
    assert.deepEqual(seenIds[0]!.sort(), ["r1", "r2"], "excluded ids are not even queried");
    assert.deepEqual([data.team.telecallers, data.team.leads, data.team.converted, data.team.calls, data.team.orders, data.team.revenue, data.team.cancelledOrders, data.team.pendingFollowUps], [2, 14, 3, 28, 3, 1797, 1, 3]);
    assert.equal(data.team.talkTimeSec, 0);
    assert.deepEqual(data.scope.map((p) => p.name).sort(), ["Aayush Tiwari", "Aryan", "Test1", "test3"], "the picker still lists everyone in scope");
    assert.equal(data.people.find((p) => p.name === "Aryan")!.orders, 1, "Aryan's own figures are untouched by the excluded accounts");
  });

  it("no roster (empty) keeps the original behaviour: every telecaller in scope", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(everyone));
    assert.equal(data.people.length, 4);
    assert.equal(data.team.orders, 1 + 2 + 30 + 5);
  });

  it("the preview text, the detailed WhatsApp text, the template notification and the Excel all show the roster only", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(everyone), roster);
    const opts = normalizeOptions({});
    const detail = fitDetailText(data, opts).text;
    const notification = toTemplateParam(data, opts, true).text;
    assert.ok(!/Test1|test3/i.test(detail + notification), "no testing account in the text outputs");
    assert.match(detail, /\*Aayush Tiwari\*[\s\S]*\*Aryan\*/);
    assert.match(detail, /\*TEAM OVERVIEW\*\nOrders: 3\nRevenue: ₹1,797/);
    assert.match(notification, /Orders 3, Revenue ₹1,797, Leads 14/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildReportXlsx(data, opts)) as never);
    const names: string[] = [];
    wb.getWorksheet("Telecaller Performance")!.eachRow((r, n) => { if (n > 1) names.push(String(r.getCell(1).value)); });
    assert.deepEqual(names, ["Aayush Tiwari", "Aryan"]);
    const team = new Map<string, unknown>();
    wb.getWorksheet("Team Summary")!.eachRow((r) => team.set(String(r.getCell(1).value), r.getCell(2).value));
    assert.deepEqual([team.get("Telecallers in report"), team.get("Orders"), team.get("Revenue")], [2, 3, 1797]);
  });

  it("a roster that matches nobody (stale ids) says so instead of silently reporting everyone", async () => {
    const data = await buildReportData(viewer, "2026-10-23", IST, sources(everyone), ["00000000-0000-0000-0000-000000000000"]);
    assert.equal(data.people.length, 0);
    assert.match(formatReportText(data, normalizeOptions({})), /No active telecallers are in this report's scope/);
  });
});

describe("data date: Today / Yesterday / a specific date / previous 7 days", () => {
  it("resolvePeriod: each mode relative to the send day; a specific date ignores the send day; month and year ends; nothing is guessed when a date is missing", () => {
    assert.deepEqual(resolvePeriod("TODAY", null, "2026-10-24"), { from: "2026-10-24", to: "2026-10-24" });
    assert.deepEqual(resolvePeriod("YESTERDAY", null, "2026-10-24"), { from: "2026-10-23", to: "2026-10-23" });
    assert.deepEqual(resolvePeriod("LAST7DAYS", null, "2026-10-24"), { from: "2026-10-17", to: "2026-10-23" });
    assert.deepEqual(resolvePeriod("LAST7DAYS", null, "2026-03-03"), { from: "2026-02-24", to: "2026-03-02" });
    assert.deepEqual(resolvePeriod("LAST7DAYS", null, "2026-01-03"), { from: "2025-12-27", to: "2026-01-02" });
    assert.deepEqual(resolvePeriod("DATE", "2026-09-15", "2026-10-24"), { from: "2026-09-15", to: "2026-09-15" });
    assert.deepEqual(resolvePeriod("DATE", "2026-09-15", "2027-05-01"), { from: "2026-09-15", to: "2026-09-15" }, "sent months later it is still that day");
    assert.throws(() => resolvePeriod("DATE", null, "2026-10-24"), /no valid date/);
    assert.throws(() => resolvePeriod("DATE", "2026-02-30", "2026-10-24"), /no valid date/);
    assert.ok(isValidDateString("2026-02-28") && !isValidDateString("2026-02-30") && !isValidDateString("26-02-28") && !isValidDateString(null));
  });

  it("the whole period is read in the report timezone and handed to the analytics source (local start of the first day to the end of the last), totals follow the period", async () => {
    const seen: { from?: string; to?: string; offset?: number; start?: Date; end?: Date } = {};
    const src: ReportSources = {
      overview: async (_v, from, to, offset) => { Object.assign(seen, { from, to, offset }); return [row("a", "Asha", { orders: 3, revenue: 300, leads: 4 })]; },
      cancelledByUser: async (_ids, s, e) => { Object.assign(seen, { start: s, end: e }); return new Map(); },
      pendingFollowUps: async () => new Map(),
    };
    const data = await buildReportData(viewer, { from: "2026-10-17", to: "2026-10-23" }, IST, src);
    assert.deepEqual([seen.from, seen.to, seen.offset], ["2026-10-17", "2026-10-23", 330]);
    assert.equal(seen.start!.toISOString(), "2026-10-16T18:30:00.000Z", "00:00 IST on the first day");
    assert.equal(seen.end!.toISOString(), "2026-10-23T18:30:00.000Z", "end of the last IST day");
    assert.deepEqual([data.from, data.to, data.date, data.team.orders], ["2026-10-17", "2026-10-23", "2026-10-23", 3]);
    await assert.rejects(() => buildReportData(viewer, { from: "2026-10-24", to: "2026-10-23" }, IST, src), /Invalid report period/);
    await assert.rejects(() => buildReportData(viewer, { from: "2026-13-01", to: "2026-13-02" }, IST, src), /Invalid report period/);
  });

  it("a single day and a range show the right header in the detailed text, the template notification and the Excel; the preview, text and Excel agree", async () => {
    const people = [row("a", "Asha", { orders: 2, revenue: 100, leads: 5 })];
    const single = await buildReportData(viewer, "2026-10-23", IST, sources(people));
    const range = await buildReportData(viewer, { from: "2026-10-17", to: "2026-10-23" }, IST, sources(people));
    const opts = normalizeOptions({});
    assert.match(formatReportText(single, opts), /^\*AYUSHWELLNESS \| DAILY TEAM REPORT\*\nDate: 23 Oct 2026\nTimezone: Asia\/Kolkata\n/);
    assert.match(formatReportText(range, opts), /^\*AYUSHWELLNESS \| DAILY TEAM REPORT\*\nPeriod: 17 Oct 2026 to 23 Oct 2026\nTimezone: Asia\/Kolkata\n/);
    assert.match(toTemplateParam(range, opts, true).text, /^Team report for 17 Oct 2026 - 23 Oct 2026 \(Asia\/Kolkata\):/);
    const wbOf = async (d: typeof single) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildReportXlsx(d, opts)) as never); const m = new Map<string, unknown>(); wb.getWorksheet("Team Summary")!.eachRow((r) => m.set(String(r.getCell(1).value), r.getCell(2).value)); return m; };
    const s1 = await wbOf(single);
    const s2 = await wbOf(range);
    assert.equal(s1.get("Report date"), "2026-10-23");
    assert.deepEqual([s2.get("Report period start"), s2.get("Report period end"), s2.has("Report date")], ["2026-10-17", "2026-10-23", false]);
    assert.equal(reportFilename("2026-10-23"), "AyushWellness_Daily_Report_2026-10-23.xlsx");
    assert.equal(reportFilename("2026-10-23", "2026-10-17"), "AyushWellness_Daily_Report_2026-10-17_to_2026-10-23.xlsx");
  });

  it("the roster still applies to a range", async () => {
    const data = await buildReportData(viewer, { from: "2026-10-17", to: "2026-10-23" }, IST, sources([row("r1", "Real", { orders: 2 }), row("t1", "Test1", { orders: 50 })]), ["r1"]);
    assert.deepEqual([data.people.map((p) => p.name), data.team.orders], [["Real"], 2]);
  });
});
