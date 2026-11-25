// End-to-end test of the Excel/CSV lead import, campaign segments, customer classification, segment filters, bulk assignment by segment and role permissions - over HTTP through the REAL lead and segment routers and
// middleware, against real tables. The import writes through the global Prisma client, so the throwaway data is COMMITTED: the suite refuses to run anywhere but the isolated database crm_iso and removes everything it created.
// Optional load test: LEAD_IMPORT_LOAD_ROWS=56000 also imports that many customers through the real upload / background import / filter-assignment path and prints the measured timings.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import ExcelJS from "exceljs";
import { prisma } from "../../../lib/prisma.js";
import { hashPassword } from "../../../lib/password.js";
import { signToken } from "../../../lib/jwt.js";
import { Role } from "../../../../generated/prisma/enums.js";
import { errorHandler } from "../../../middlewares/errorHandler.js";
import { requestId } from "../../../middlewares/requestId.js";
import leadRoutes from "../lead.routes.js";
import segmentRoutes from "../../segments/segments.routes.js";
import { processChunk, resumeInterruptedImports } from "./import.runner.js";

const RUN = String(10 + Math.floor(Math.random() * 90));
const phone = (i: number) => `7${RUN}${String(i).padStart(7, "0")}`;
const e164 = (i: number) => `+91${phone(i)}`;
const tag = randomUUID().slice(0, 6);
const dir = mkdtempSync(join(tmpdir(), "lead-import-db-"));

let server: Server;
let base = "";
const users: Record<string, { id: string; username: string; role: Role }> = {};
const tokens: Record<string, string> = {};
const segmentIds: string[] = [];

async function makeUser(key: string, role: Role, extra: Record<string, unknown> = {}) {
  const username = `li-${tag}-${key}`;
  const u = await prisma.user.create({ data: { name: `LI ${key}`, username, role, passwordHash: await hashPassword("pw-123456"), ...extra } as never, select: { id: true } });
  users[key] = { id: u.id, username, role };
  tokens[key] = signToken({ sub: u.id, role, username } as never);
}

before(async () => {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (rows[0]?.current_database !== "crm_iso") throw new Error(`GUARD: this suite commits throwaway data and only runs on crm_iso (got ${rows[0]?.current_database})`);
  await makeUser("admin", Role.ADMIN);
  await makeUser("m1", Role.MANAGER);
  await makeUser("m2", Role.MANAGER);
  await makeUser("s1", Role.SALESPERSON, { reportingManagerId: users.m1!.id });
  await makeUser("s2", Role.SALESPERSON, { reportingManagerId: users.m1!.id });
  await makeUser("s3", Role.SALESPERSON, { reportingManagerId: users.m2!.id });
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/lead", leadRoutes);
  app.use("/segments", segmentRoutes);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const ids = (await prisma.$queryRaw<{ id: string }[]>`SELECT id::text FROM leads WHERE normalized_mobile LIKE ${`+917${RUN}%`} OR lead_number LIKE ${`EX-${tag}-%`} OR import_batch_id IN (SELECT id FROM lead_import_batches WHERE uploaded_by_id IN (SELECT id FROM users WHERE username LIKE ${`li-${tag}-%`}))`).map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM activities WHERE lead_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM lead_assignments WHERE lead_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM leads WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM lead_import_batches WHERE uploaded_by_id IN (SELECT id FROM users WHERE username LIKE ${`li-${tag}-%`})`;
  await prisma.$executeRaw`DELETE FROM lead_import_mappings WHERE created_by_id IN (SELECT id FROM users WHERE username LIKE ${`li-${tag}-%`})`;
  await prisma.$executeRaw`DELETE FROM salesperson_assignment_round_robin WHERE manager_id IN (SELECT id FROM users WHERE username LIKE ${`li-${tag}-%`})`;
  await prisma.$executeRaw`UPDATE manager_assignment_round_robin SET last_assigned_manager_id = NULL WHERE last_assigned_manager_id IN (SELECT id FROM users WHERE username LIKE ${`li-${tag}-%`})`;
  for (const id of segmentIds) await prisma.$executeRaw`DELETE FROM segments WHERE id = ${id}::uuid AND is_system = false`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`li-${tag}-%`}`;
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------------------------- helpers
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const api = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...auth(who), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text };
};

async function xlsx(headers: string[], rows: (string | number | null)[][], name = "customers.xlsx") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Customers");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  const file = join(dir, `${randomUUID()}-${name}`);
  await wb.xlsx.writeFile(file);
  return file;
}
async function upload(who: string, file: string, name: string, segmentId?: string) {
  const { readFileSync } = await import("node:fs");
  const form = new FormData();
  form.set("file", new Blob([readFileSync(file)]), name);
  if (segmentId) form.set("segmentId", segmentId);
  const res = await fetch(`${base}/lead/leads/import/file`, { method: "POST", headers: auth(who), body: form });
  const json = (await res.json()) as any;

  return { status: res.status, json };
}
async function finish(who: string, batchId: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const p = (await api(who, "GET", `/lead/leads/import/${batchId}/progress`)).json.data;
    if (p.status === "COMMITTED" || p.status === "FAILED") return p;
    if (Date.now() - t0 > timeoutMs) throw new Error(`import did not finish: ${JSON.stringify(p)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function newSegment(name: string, who = "admin") {
  const r = await api(who, "POST", "/segments", { name });
  if (r.status === 201) segmentIds.push(r.json.data.id);
  return r;
}
// the first file has TWO rows for phone(1) ("Rahul Sharma" and "Rahul Again"): this returns the Sharma one
const byMobile = (i: number) => prisma.lead.findFirst({ where: { normalizedMobile: e164(i), NOT: { lastName: "Again" } }, include: { segments: { include: { segment: true } } } });

const HEAD = ["Customer Name", "Phone Number", "Email ID", "Total Orders", "Total Orders Value", "City", "State", "Address", "Product Name", "Last Order Date", "Payment Mode", "Favourite Colour"];

// ----------------------------------------------------------------------------------------------- the tests
describe("segment management and its permissions", () => {
  it("only an Admin creates, renames, recolours, deactivates or deletes; managers and salespeople may only read", async () => {
    assert.equal((await api("m1", "POST", "/segments", { name: `Nope ${tag}` })).status, 403);
    assert.equal((await api("s1", "POST", "/segments", { name: `Nope ${tag}` })).status, 403);
    const created = await newSegment(`Diwali Mega Sale ${tag}`);
    assert.equal(created.status, 201);
    const id = created.json.data.id;
    assert.equal((await api("m1", "PATCH", `/segments/${id}`, { name: "x" })).status, 403);
    assert.equal((await api("s1", "DELETE", `/segments/${id}`)).status, 403);
    assert.equal((await api("admin", "PATCH", `/segments/${id}`, { name: `Diwali Sale ${tag}`, color: "#ff0000" })).json.data.color, "#ff0000");
    assert.equal((await api("admin", "PATCH", `/segments/${id}`, { color: "red" })).status, 400);
    for (const who of ["admin", "m1", "s1"]) assert.equal((await api(who, "GET", "/segments")).status, 200, who);
    assert.equal((await api("s1", "GET", "/segments?counts=true")).json.data[0].counts, null, "a salesperson gets the tags, not counts");
  });
  it("names are unique ignoring case and spacing; the three built-in segments exist and cannot be deleted", async () => {
    await newSegment(`November Repeat ${tag}`);
    assert.equal((await api("admin", "POST", "/segments", { name: `  november   REPEAT ${tag} ` })).status, 409);
    const list = (await api("admin", "GET", "/segments")).json.data as { id: string; name: string; isSystem: boolean }[];
    for (const n of ["Repeat Customers", "Loyal Customers", "VIP Customers"]) assert.ok(list.find((s) => s.name === n && s.isSystem), n);
    const vip = list.find((s) => s.name === "VIP Customers")!;
    assert.equal((await api("admin", "DELETE", `/segments/${vip.id}`)).status, 409);
  });
});

describe("Excel import: detection, preview, segment, classification, data preservation", () => {
  let segA = "";
  let batchId = "";
  const rows = [
    ["Rahul Sharma", phone(1), "rahul@example.test", 5, "Rs. 25,000", "Pune", "MH", "12 MG Road", "Herbal Tea", "12/11/2026", "COD", "Blue"], // VIP
    ["Priya Shah", String(phone(2)), "priya@example.test", 3, 9000, "Mumbai", "MH", "5 Link Rd", "Oil", "2026-11-01", "Prepaid", "Red"], // LOYAL
    ["Amit Verma", phone(3), "", 2, 4000, "Delhi", "DL", "", "Soap", "", "COD", ""], // REPEAT
    ["Single Buyer", phone(4), "", 1, 500, "", "", "", "", "", "", ""], // not classified
    ["No Count", phone(5), "", "", "", "", "", "", "", "", "", ""], // missing order count
    ["Bad Count", phone(6), "", "abc", "", "", "", "", "", "", "", ""], // invalid order count
    ["Email Only", "", "emailonly@example.test", 4, 7000, "", "", "", "", "", "", ""], // missing phone, has email -> LOYAL
    ["Nobody", "", "", 3, "", "", "", "", "", "", "", ""], // no phone or email -> failed
    ["Bad Phone", "12345", "", 3, "", "", "", "", "", "", "", ""], // invalid phone -> failed
    ["Rahul Again", phone(1), "", 5, "", "", "", "", "", "", "", ""], // duplicate of row 1 in the file
    ["=HYPERLINK(\"http://evil\")", "", "", "", "", "", "", "", "", "", "", ""], // formula text in a failed row
  ] as (string | number | null)[][];

  it("detects every column automatically and previews totals, duplicates, invalid rows and missing data", async () => {
    segA = (await newSegment(`Repeat Buyers ${tag}`)).json.data.id;
    const up = await upload("admin", await xlsx(HEAD, rows), "november-customers.xlsx", segA);
    assert.equal(up.status, 200);
    const d = up.json.data;
    batchId = d.batchId;
    assert.equal(d.totalRows, 11);
    assert.equal(d.mapping["Customer Name"], "fullName");
    assert.equal(d.mapping["Phone Number"], "mobile");
    assert.equal(d.mapping["Total Orders"], "orderCount");
    assert.equal(d.mapping["Total Orders Value"], "totalOrdersValue");
    assert.equal(d.mapping["Last Order Date"], "lastOrderDate");
    assert.equal(d.mapping["Favourite Colour"], "extra", "an unrecognised column is kept, not dropped");
    assert.deepEqual(d.unrecognized, ["Favourite Colour"]);
    assert.deepEqual(d.needsReview, [], "nothing needs manual mapping");
    assert.equal(d.segmentId, segA);
    const p = d.preview;
    assert.equal(p.eligibleRows, 8, "every valid row is eligible - the repeated phone included");
    assert.equal(p.newLeads, 8, "each one becomes its own new lead");
    assert.equal(p.invalidRows, 3); // nobody, bad phone, formula row
    assert.equal(p.missingPhone, 3);
    assert.equal(p.missingOrderCount, 1);
    assert.equal(p.invalidOrderCount, 1);
    assert.deepEqual(p.classification, { repeat: 1, loyal: 2, vip: 2, unclassified: 3 });
  });

  it("imports in the background with progress, classifies by order count and tags every imported lead with the segment", async () => {
    const start = await api("admin", "POST", `/lead/leads/import/${batchId}/start`, {});
    assert.equal(start.status, 202);
    const p = await finish("admin", batchId);
    assert.equal(p.status, "COMMITTED");
    assert.equal(p.percent, 100);
    assert.equal(p.created, 8, "all 8 valid rows became leads");
    assert.deepEqual([p.updated, p.duplicates], [0, 0], "nothing is matched, updated or skipped");
    assert.equal(p.failed, 3);
    assert.equal(p.segmentMembershipsAdded, 8);
    const rahul = (await byMobile(1))!;
    assert.equal(rahul.customerClass, "VIP");
    assert.equal(rahul.orderCount, 5);
    assert.equal(Number(rahul.totalOrdersValue), 25000);
    assert.equal(rahul.firstName, "Rahul");
    assert.equal(rahul.lastName, "Sharma");
    assert.equal(rahul.location, "Pune, MH");
    assert.equal(rahul.lastOrderAt?.toISOString().slice(0, 10), "2026-11-12");
    assert.deepEqual(rahul.importData, { fields: { city: "Pune", state: "MH", address: "12 MG Road", product: "Herbal Tea", paymentInfo: "COD", lastOrderDate: "2026-11-12" }, extra: { "Favourite Colour": "Blue" }, });
    assert.equal((await byMobile(2))!.customerClass, "LOYAL");
    assert.equal((await byMobile(3))!.customerClass, "REPEAT");
    assert.equal((await byMobile(4))!.customerClass, null, "one order is not a classification");
    const noCount = (await byMobile(5))!;
    assert.equal(noCount.customerClass, null, "a missing order count is never classified");
    assert.equal(noCount.orderCount, null);
    assert.equal((await byMobile(6))!.customerClass, null, "an invalid order count is never classified");
    const emailOnly = (await prisma.lead.findFirst({ where: { normalizedEmail: "emailonly@example.test" } }))!;
    assert.equal(emailOnly.customerClass, "LOYAL");
    assert.equal(emailOnly.mobile, null);
    // the segment came from the upload, not from the classification: both are independently present
    for (const i of [1, 2, 3, 4, 5, 6]) assert.deepEqual((await byMobile(i))!.segments.map((s) => s.segmentId), [segA], `lead ${i}`);
    // the repeated phone is two independent leads, each with its own order count and the segment
    const both = await prisma.lead.findMany({ where: { normalizedMobile: e164(1) }, include: { segments: true } });
    assert.equal(both.length, 2);
    assert.ok(both.every((l) => l.customerClass === "VIP" && l.segments.length === 1));
  });

  it("downloads the failed rows with their reasons, and a duplicate report; spreadsheet formulas are neutralised", async () => {
    const failed = await api("admin", "GET", `/lead/leads/import/${batchId}/report?kind=failed`);
    assert.equal(failed.status, 200);
    assert.match(failed.text, /No phone number or email/);
    assert.match(failed.text, /Phone number is not valid/);
    assert.ok(failed.text.includes("'=HYPERLINK"), "a formula cell is prefixed so Excel will not run it");
    assert.ok(failed.text.split("\r\n")[0]!.includes("Customer Name"), "the original columns come back so the file can be corrected and re-uploaded");
    const dup = await api("admin", "GET", `/lead/leads/import/${batchId}/report?kind=duplicates`);
    assert.equal(dup.text.split("\r\n").filter(Boolean).length, 1, "nothing is treated as a duplicate any more: the report has only its header");
  });

  it("a second file never touches existing leads: every row is a NEW lead, even for a phone that already exists, and the first file's leads are unchanged", async () => {
    const segB = (await newSegment(`VIP Special ${tag}`)).json.data.id;
    const before = (await byMobile(1))!;
    const second = await xlsx(HEAD, [
      ["", phone(1), "", "", "", "", "", "", "", "", "", ""],
      ["Amit Different Name", phone(3), "amit@example.test", 4, "", "", "", "", "", "", "", "Green"],
      ["Brand New", phone(7), "", 6, 12000, "Surat", "GJ", "", "", "", "", ""],
    ]);
    const up = await upload("admin", second, "november-customers.xlsx", segB);
    assert.equal(up.json.data.rememberedMapping, true, "the same header format finds its remembered mapping");
    assert.equal(up.json.data.preview.newLeads, 3, "all 3 rows will be new leads");
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    const p = await finish("admin", up.json.data.batchId);
    assert.deepEqual([p.created, p.updated, p.duplicates, p.failed, p.segmentMembershipsAdded], [3, 0, 0, 0, 3]);
    // the earlier leads are exactly as they were
    const rahul = (await byMobile(1))!;
    assert.deepEqual([rahul.firstName, rahul.orderCount, rahul.customerClass, rahul.email], [before.firstName, 5, "VIP", before.email]);
    assert.deepEqual(rahul.segments.map((s) => s.segmentId), [segA], "the old lead did not get the new segment");
    const amitLeads = await prisma.lead.findMany({ where: { normalizedMobile: e164(3) }, include: { segments: true }, orderBy: { createdAt: "asc" } });
    assert.equal(amitLeads.length, 2, "Amit exists twice: the original and the new import row");
    assert.equal(amitLeads[0]!.orderCount, 2, "the original is unchanged");
    const fresh = amitLeads.find((l) => l.importBatchId === up.json.data.batchId)!;
    assert.deepEqual([fresh.firstName, fresh.orderCount, fresh.customerClass, fresh.segments.map((x) => x.segmentId)], ["Amit", 4, "LOYAL", [segB]]);
    assert.equal(await prisma.lead.count({ where: { normalizedMobile: { startsWith: `+917${RUN}` } } }), 7 + 3, "7 phone rows from the first file (the 8th has only an email) + 3 new, none merged");
  });

  it("120 valid rows, 76 of them matching existing CRM leads: exactly 120 NEW leads are created, the 76 existing leads are untouched, all carry the segment", async () => {
    const seg = (await newSegment(`Hundred Twenty ${tag}`)).json.data.id;
    // 76 customers that already exist in the CRM (phone + email)
    const existing = Array.from({ length: 76 }, (_, i) => ({ id: randomUUID(), leadNumber: `EX-${tag}-${i}`, firstName: `Existing${i}`, mobile: phone(7000 + i), normalizedMobile: e164(7000 + i), email: `ex${i}@example.test`, normalizedEmail: `ex${i}@example.test`, orderCount: 1 }));
    await prisma.lead.createMany({ data: existing });
    const rows = Array.from({ length: 120 }, (_, i) => (i < 76 ? [`Row ${i}`, phone(7000 + i), `ex${i}@example.test`, 3, "", "", "", "", "", "", "", ""] : [`Row ${i}`, phone(7000 + i), "", 2, "", "", "", "", "", "", "", ""])) as (string | number | null)[][];
    const up = await upload("admin", await xlsx(HEAD, rows), "hundred-twenty.xlsx", seg);
    assert.equal(up.json.data.totalRows, 120);
    assert.deepEqual([up.json.data.preview.eligibleRows, up.json.data.preview.newLeads, up.json.data.preview.invalidRows], [120, 120, 0]);
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    const p = await finish("admin", up.json.data.batchId);
    assert.deepEqual([p.status, p.created, p.updated, p.duplicates, p.failed, p.segmentMembershipsAdded], ["COMMITTED", 120, 0, 0, 0, 120]);
    assert.equal(await prisma.lead.count({ where: { importBatchId: up.json.data.batchId } }), 120, "exactly 120 new leads in the database");
    assert.equal(await prisma.leadSegment.count({ where: { segmentId: seg } }), 120, "all 120 carry the selected segment");
    const stillThere = await prisma.lead.findMany({ where: { leadNumber: { startsWith: `EX-${tag}-` } }, select: { firstName: true, orderCount: true, importBatchId: true, customerClass: true } });
    assert.equal(stillThere.length, 76);
    assert.ok(stillThere.every((l) => l.firstName.startsWith("Existing") && l.orderCount === 1 && l.importBatchId === null && l.customerClass === null), "the 76 existing leads were not updated");
    console.log(`IMPORT 120 RESULT: rows=120 created=${p.created} newLeadsInDb=${await prisma.lead.count({ where: { importBatchId: up.json.data.batchId } })} updated=${p.updated} skipped=${p.duplicates} existingUntouched=${stillThere.length}`);
  });

  it("manual mapping is only for unrecognised columns, and is validated", async () => {
    const f = await xlsx(["Name", "Mobile", "Loyalty Points"], [["Zed", phone(8), "40"]]);
    const up = await upload("admin", f, "points.xlsx");
    const id = up.json.data.batchId;
    assert.equal((await api("admin", "PATCH", `/lead/leads/import/${id}/mapping`, { mapping: { Nope: "city" } })).status, 400);
    assert.equal((await api("admin", "PATCH", `/lead/leads/import/${id}/mapping`, { mapping: { "Loyalty Points": "bogusField" } })).status, 400);
    const ok = await api("admin", "PATCH", `/lead/leads/import/${id}/mapping`, { mapping: { "Loyalty Points": "orderCount" } });
    assert.equal(ok.json.data.mapping["Loyalty Points"], "orderCount");
    assert.equal(ok.json.data.preview.classification.vip, 1, "the manual mapping took effect: 40 orders is a VIP");
    assert.equal((await api("admin", "PATCH", `/lead/leads/import/${id}/mapping`, { mapping: { "Loyalty Points": "extra" } })).status, 200);
    // an unusable file is refused, and nothing is left behind
    const noContact = await xlsx(["Name", "City"], [["A", "B"]]);
    const up2 = await upload("admin", noContact, "nocontact.xlsx");
    assert.equal((await api("admin", "POST", `/lead/leads/import/${up2.json.data.batchId}/start`, {})).status, 400, "needs a phone or email column");
  });

  it("refuses unsupported files, an empty file and an inactive segment", async () => {
    assert.equal((await upload("admin", await xlsx(HEAD, []), "empty.xlsx")).status, 400);
    const { writeFileSync } = await import("node:fs");
    const xls = join(dir, "old.xls");
    writeFileSync(xls, "x");
    const r = await upload("admin", xls, "old.xls");
    assert.equal(r.status, 400);
    assert.match(r.json.message, /\.xlsx or \.csv/);
    const inactive = (await newSegment(`Archived ${tag}`)).json.data.id;
    await api("admin", "PATCH", `/segments/${inactive}`, { isActive: false });
    assert.equal((await upload("admin", await xlsx(HEAD, [["A", phone(9), "", 2, "", "", "", "", "", "", "", ""]]), "x.xlsx", inactive)).status, 400);
  });

  it("reads a CSV the same way", async () => {
    const { writeFileSync } = await import("node:fs");
    const csv = join(dir, "c.csv");
    writeFileSync(csv, `Name,Mobile No,Orders\nCsv Person,${phone(10)},2\n`);
    const up = await upload("admin", csv, "c.csv");
    assert.equal(up.status, 200);
    assert.equal(up.json.data.mapping["Mobile No"], "mobile");
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    await finish("admin", up.json.data.batchId);
    assert.equal((await byMobile(10))!.customerClass, "REPEAT");
  });
});

describe("filters, bulk assignment by segment, and what each role sees", () => {
  let seg = "";
  const N = 40;
  before(async () => {
    seg = (await newSegment(`Assign Me ${tag}`)).json.data.id;
    const rows = Array.from({ length: N }, (_, i) => [`Cust ${i}`, phone(100 + i), "", i % 3 === 0 ? 5 : i % 3 === 1 ? 3 : 2, "", "", "", "", "", "", "", ""]);
    const up = await upload("admin", await xlsx(HEAD, rows as (string | number | null)[][]), "assign.xlsx", seg);
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    await finish("admin", up.json.data.batchId);
  });

  it("filters by segment and by customer classification, independently and together", async () => {
    const all = await api("admin", "GET", `/lead/leads?segmentId=${seg}&limit=100`);
    assert.equal(all.json.data.pagination.total, N);
    for (const lead of all.json.data.data) {
      assert.deepEqual(lead.segments.map((s: any) => s.id), [seg]);
      assert.ok(["VIP", "LOYAL", "REPEAT"].includes(lead.customerClass), "both tags are on every lead");
    }
    assert.equal((await api("admin", "GET", `/lead/leads?segmentId=${seg}&customerClass=VIP`)).json.data.pagination.total, 14);
    assert.equal((await api("admin", "GET", `/lead/leads?segmentId=${seg}&customerClass=LOYAL`)).json.data.pagination.total, 13);
    assert.equal((await api("admin", "GET", `/lead/leads?customerClass=REPEAT&segmentId=${seg}`)).json.data.pagination.total, 13);
    assert.equal((await api("admin", "GET", `/lead/leads?segmentId=${seg}&customerClass=NOPE`)).status, 400);
  });

  it("assigns every lead in a segment to a manager by filter, and segment counts show assigned vs unassigned", async () => {
    let counts = (await api("admin", "GET", `/segments/${seg}`)).json.data.counts;
    assert.deepEqual([counts.total, counts.assigned, counts.unassigned], [N, 0, N]);
    const r = await api("admin", "POST", "/lead/leads/bulk/assign-manager", { filter: { segmentId: seg, assignment: "UNASSIGNED" }, method: "MANUAL", managerId: users.m1!.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.assignedCount, N);
    counts = (await api("admin", "GET", `/segments/${seg}`)).json.data.counts;
    assert.deepEqual([counts.total, counts.assigned, counts.unassigned, counts.withManagerOnly], [N, N, 0, N]);
    // a manager sees counts for THEIR leads only
    assert.equal((await api("m1", "GET", `/segments/${seg}`)).json.data.counts.total, N);
    assert.equal((await api("m2", "GET", `/segments/${seg}`)).json.data.counts.total, 0);
    // segment and classification are untouched by assignment
    const sample = (await api("m1", "GET", `/lead/leads?segmentId=${seg}&limit=100`)).json.data.data;
    assert.equal(sample.length, N);
    assert.ok(sample.every((l: any) => l.segments.length === 1 && l.segments[0].id === seg && l.customerClass));
  });

  it("a manager round-robins a whole segment to salespeople; the segment and classification tags stay and only the right people see the leads", async () => {
    const r = await api("m1", "POST", "/lead/leads/bulk/assign-salesperson", { filter: { segmentId: seg }, method: "ROUND_ROBIN", salespersonIds: [users.s1!.id, users.s2!.id] });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.assignedCount, N);
    const s1 = (await api("s1", "GET", `/lead/leads?segmentId=${seg}&limit=100`)).json.data;
    const s2 = (await api("s2", "GET", `/lead/leads?segmentId=${seg}&limit=100`)).json.data;
    assert.equal(s1.pagination.total + s2.pagination.total, N);
    assert.equal(s1.pagination.total, N / 2, "an even split");
    for (const lead of [...s1.data, ...s2.data]) {
      assert.deepEqual(lead.segments.map((s: any) => s.name), [`Assign Me ${tag}`]);
      assert.ok(lead.customerClass);
    }
    // a salesperson sees one lead's detail with both tags
    const one = (await api("s1", "GET", `/lead/leads/${s1.data[0].id}`)).json.data;
    assert.equal(one.segments[0].name, `Assign Me ${tag}`);
    assert.ok(one.customerClass);
    // no cross-access: another manager's salesperson and another manager see none of them
    assert.equal((await api("s3", "GET", `/lead/leads?segmentId=${seg}`)).json.data.pagination.total, 0);
    assert.equal((await api("m2", "GET", `/lead/leads?segmentId=${seg}`)).json.data.pagination.total, 0);
    assert.equal((await api("s1", "GET", `/lead/leads/${s2.data[0].id}`)).status, 404);
    const counts = (await api("admin", "GET", `/segments/${seg}`)).json.data.counts;
    assert.deepEqual([counts.total, counts.withSalesperson, counts.unassigned], [N, N, 0]);
  });

  it("a filter bulk-assign respects scope: a manager cannot assign leads that are not theirs, and the body must carry ids or a filter, not both", async () => {
    const r = await api("m2", "POST", "/lead/leads/bulk/assign-salesperson", { filter: { segmentId: seg }, method: "MANUAL", salespersonId: users.s3!.id });
    assert.equal(r.status, 400, "m2 has no leads in this segment");
    assert.equal((await api("m2", "POST", "/lead/leads/bulk/assign-salesperson", { method: "MANUAL", salespersonId: users.s3!.id })).status, 400);
    assert.equal((await api("m2", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds: [randomUUID()], filter: { segmentId: seg }, method: "MANUAL", salespersonId: users.s3!.id })).status, 400);
    assert.equal((await api("s1", "POST", "/lead/leads/bulk/assign-salesperson", { filter: { segmentId: seg }, method: "MANUAL", salespersonId: users.s1!.id })).status, 403);
    // the old explicit-id form still works
    const ids = (await api("m1", "GET", `/lead/leads?segmentId=${seg}&limit=2`)).json.data.data.map((l: any) => l.id);
    assert.equal((await api("m1", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds: ids, method: "MANUAL", salespersonId: users.s2!.id })).json.data.assignedCount, 2);
  });
});

describe("who may import, and whose batch it is", () => {
  it("salespeople cannot import; a manager can, keeps the leads, and another manager cannot see their batch", async () => {
    const f = await xlsx(HEAD, [["Mgr Import", phone(300), "", 2, "", "", "", "", "", "", "", ""]]);
    assert.equal((await upload("s1", f, "x.xlsx")).status, 403);
    const up = await upload("m1", f, "m.xlsx");
    assert.equal(up.status, 200);
    const id = up.json.data.batchId;
    assert.equal((await api("m2", "GET", `/lead/leads/import/${id}/progress`)).status, 404);
    assert.equal((await api("m2", "POST", `/lead/leads/import/${id}/start`, {})).status, 404);
    assert.equal((await api("m2", "GET", `/lead/leads/import/${id}/report`)).status, 404);
    await api("m1", "POST", `/lead/leads/import/${id}/start`, {});
    await finish("m1", id);
    assert.equal((await byMobile(300))!.assignedManagerId, users.m1!.id, "a manager's import lands under that manager");
    // the same batch cannot be started twice
    assert.equal((await api("m1", "POST", `/lead/leads/import/${id}/start`, {})).status, 409);
  });
});

describe("recovery and concurrency", () => {
  it("an import cut short part-way resumes from its remaining rows and creates nothing twice", async () => {
    const rows = Array.from({ length: 1300 }, (_, i) => [`R${i}`, phone(1000 + i), "", 2, "", "", "", "", "", "", "", ""]) as (string | number | null)[][];
    const seg = (await newSegment(`Resume ${tag}`)).json.data.id;
    const up = await upload("admin", await xlsx(HEAD, rows), "resume.xlsx", seg);
    const id = up.json.data.batchId as string;
    // simulate a crash after the first chunk: mark it running, process ONE chunk, then stop
    await prisma.leadImportBatch.update({ where: { id }, data: { status: "PROCESSING", startedAt: new Date() } });
    const batch = (await prisma.leadImportBatch.findUnique({ where: { id } }))!;
    const chunk = await prisma.leadImportRow.findMany({ where: { batchId: id, status: "PENDING" }, orderBy: { id: "asc" }, take: 500, select: { id: true, rowNumber: true, data: true } });
    await prisma.$transaction((tx) => processChunk(tx, { batchId: id, mapping: (batch.columnMapping as any).mapping, segmentId: seg, uploaderId: users.admin!.id, uploaderRole: Role.ADMIN }, chunk, new Map()), { timeout: 60_000 });
    assert.equal(await prisma.leadImportRow.count({ where: { batchId: id, status: "PENDING" } }), 800);
    assert.equal(await prisma.lead.count({ where: { importBatchId: id } }), 500);
    // "restart": the interrupted batch continues
    assert.ok((await resumeInterruptedImports()) >= 1);
    const p = await finish("admin", id);
    assert.equal(p.status, "COMMITTED");
    assert.equal(p.created, 1300);
    assert.equal(await prisma.lead.count({ where: { importBatchId: id } }), 1300);
    assert.equal(await prisma.leadSegment.count({ where: { segmentId: seg } }), 1300);
  });

  it("two imports of the same file running at once each create all their rows (nothing is merged)", async () => {
    const rows = Array.from({ length: 700 }, (_, i) => [`C${i}`, phone(5000 + i), "", 3, "", "", "", "", "", "", "", ""]) as (string | number | null)[][];
    const f1 = await xlsx(HEAD, rows);
    const f2 = await xlsx(HEAD, rows);
    const [a, b] = await Promise.all([upload("admin", f1, "a.xlsx"), upload("m1", f2, "b.xlsx")]);
    await Promise.all([api("admin", "POST", `/lead/leads/import/${a.json.data.batchId}/start`, {}), api("m1", "POST", `/lead/leads/import/${b.json.data.batchId}/start`, {})]);
    const [pa, pb] = await Promise.all([finish("admin", a.json.data.batchId), finish("m1", b.json.data.batchId)]);
    assert.deepEqual([pa.created, pb.created, pa.updated + pb.updated], [700, 700, 0], "each import created all of its own rows; nothing was matched or merged");
    const dups = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM (SELECT normalized_mobile FROM leads WHERE normalized_mobile LIKE ${`+917${RUN}0005%`} GROUP BY normalized_mobile HAVING count(*) = 2) d`;
    assert.equal(Number(dups[0]!.n), 700, "each phone is two independent leads (one per import), never merged");
  });
});

describe("large import (optional): LEAD_IMPORT_LOAD_ROWS", () => {
  const ROWS = Number(process.env.LEAD_IMPORT_LOAD_ROWS ?? 0);
  it(ROWS ? `imports ${ROWS.toLocaleString("en-IN")} customers, tags them with a segment, and assigns the whole segment` : "skipped (set LEAD_IMPORT_LOAD_ROWS=56000 to run)", { skip: !ROWS }, async () => {
    const seg = (await newSegment(`Load ${tag}`)).json.data.id;
    // build the workbook with the streaming writer (the file is the test input, not the thing under test)
    const file = join(dir, "load.xlsx");
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file });
    const ws = wb.addWorksheet("Customers");
    ws.addRow(HEAD).commit();
    const OFFSET = 1_000_000;
    for (let i = 0; i < ROWS; i++) {
      // every 50th row repeats the previous customer (a duplicate), every 97th has no contact (invalid)
      const dup = i % 50 === 49;
      const bad = i % 97 === 96;
      ws.addRow([`Load Customer ${i}`, bad ? "" : phone(OFFSET + (dup ? i - 1 : i)), bad ? "" : `load${i}@example.test`.replace(/^load\d+/, dup ? "dup" : `load${i}`), 2 + (i % 5), 1000 + i, "Pune", "MH", "Some address", "Herbal Tea", "12/11/2026", "COD", `c${i % 7}`]).commit();
    }
    await ws.commit();
    await wb.commit();
    const { statSync } = await import("node:fs");
    const mb = statSync(file).size / 1024 / 1024;

    const t0 = Date.now();
    const up = await upload("admin", file, "load.xlsx", seg);
    assert.equal(up.status, 200, JSON.stringify(up.json).slice(0, 300));
    const tUpload = Date.now() - t0;
    const preview = up.json.data.preview;
    assert.equal(preview.totalRows, ROWS);

    const t1 = Date.now();
    const rss0 = process.memoryUsage().rss;
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    const p = await finish("admin", up.json.data.batchId, 30 * 60_000);
    const tImport = Date.now() - t1;
    assert.equal(p.status, "COMMITTED");
    assert.equal(p.processedRows, ROWS);
    assert.equal(p.created + p.updated + p.duplicates + p.failed, ROWS);
    assert.equal(p.segmentMembershipsAdded, p.created + p.updated);
    assert.equal(await prisma.leadSegment.count({ where: { segmentId: seg } }), p.created + p.updated);
    const unclassified = await prisma.lead.count({ where: { importBatchId: up.json.data.batchId, customerClass: null } });
    assert.equal(unclassified, 0, "every imported customer had 2+ orders");
    const dupMobiles = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM (SELECT normalized_mobile FROM leads WHERE normalized_mobile LIKE ${`+917${RUN}1%`} GROUP BY normalized_mobile HAVING count(*) > 1) d`;
    assert.equal(Number(dupMobiles[0]!.n), 0, "no duplicate leads");

    const t2 = Date.now();
    const a1 = await api("admin", "POST", "/lead/leads/bulk/assign-manager", { filter: { segmentId: seg, assignment: "UNASSIGNED" }, method: "MANUAL", managerId: users.m1!.id });
    const tAssignMgr = Date.now() - t2;
    assert.equal(a1.status, 200, JSON.stringify(a1.json).slice(0, 300));
    assert.equal(a1.json.data.assignedCount, p.created + p.updated);
    const t3 = Date.now();
    const a2 = await api("m1", "POST", "/lead/leads/bulk/assign-salesperson", { filter: { segmentId: seg }, method: "ROUND_ROBIN", salespersonIds: [users.s1!.id, users.s2!.id] });
    const tAssignSp = Date.now() - t3;
    assert.equal(a2.status, 200, JSON.stringify(a2.json).slice(0, 300));
    const counts = (await api("admin", "GET", `/segments/${seg}`)).json.data.counts;
    assert.equal(counts.total, p.created + p.updated);
    assert.equal(counts.withSalesperson, p.created + p.updated);
    assert.equal(counts.unassigned, 0);
    const tList = Date.now();
    const list = await api("s1", "GET", `/lead/leads?segmentId=${seg}&limit=20`);
    const tListMs = Date.now() - tList;
    assert.ok(list.json.data.data[0].segments.length === 1 && list.json.data.data[0].customerClass);
    console.log(
      `LOAD RESULT rows=${ROWS} fileMB=${mb.toFixed(1)} created=${p.created} updated=${p.updated} duplicates=${p.duplicates} failed=${p.failed} | upload+stage+preview=${(tUpload / 1000).toFixed(1)}s import=${(tImport / 1000).toFixed(1)}s ` +
        `(${Math.round(ROWS / (tImport / 1000))} rows/s) assignToManager=${(tAssignMgr / 1000).toFixed(1)}s roundRobinToSalespeople=${(tAssignSp / 1000).toFixed(1)}s firstPageForSalesperson=${tListMs}ms | rssDeltaMB=${Math.round((process.memoryUsage().rss - rss0) / 1048576)} peakRssMB=${Math.round(process.memoryUsage().rss / 1048576)}`,
    );
  });
});

describe("lead status from the Tagging column", () => {
  const HEADER = ["Name", "Mobile", "lead source", "City", "Tagging ", "Feedback"];
  // [name, phone number, Tagging, Feedback (always disagrees), expected status]
  const cases: [string, number, string, string, string][] = [
    ["Tag Ringing", 801, "Ringing ", "Interested", "RINGING"],
    ["Tag Interested", 802, "Intrested ", "Not interested", "INTERESTED"],
    ["Tag Busy", 803, "Busy ", "Converted", "BUSY"],
    ["Tag NotInterested", 804, "not intersted ", "Interested", "NOT_INTERESTED"],
    ["Tag SwitchOff", 805, "Switch off", "Ringing", "SWITCHED_OFF"],
    ["Tag FollowUp", 806, "follow up", "Busy", "FOLLOW_UP"],
    ["Tag Converted", 807, "Converted ", "Busy", "CONVERTED"],
    ["Tag CallBack", 808, "Call back ", "Busy", "CALL_BACK"],
    ["Tag NotReachable", 809, "Not rechable ", "Busy", "NOT_REACHABLE"],
    ["Tag Blank", 810, "", "Interested", "NEW"],
    ["Tag Unknown", 811, "Member busy ", "Interested", "NEW"],
  ];
  let batchId = "";
  const expectedSummary = {
    column: "Tagging",
    recognized: 9,
    blank: 1,
    unrecognized: 1,
    statuses: ["BUSY", "CALL_BACK", "CONVERTED", "FOLLOW_UP", "INTERESTED", "NOT_INTERESTED", "NOT_REACHABLE", "RINGING", "SWITCHED_OFF"].map((status) => ({ status, count: 1 })),
    unrecognizedValues: [{ value: "Member busy", count: 1 }],
  };

  it("the preview shows the Tagging column and what it will assign; rows that cannot be imported are not counted", async () => {
    const file = await xlsx(HEADER, [
      ...cases.map(([name, i, tagging, feedback]) => [name, phone(i), "Field visit", "Pune", tagging, feedback]),
      ["No Contact", "", "", "", "Busy", ""],
    ]);
    const up = await upload("admin", file, "distributors.xlsx");
    assert.equal(up.status, 200);
    batchId = up.json.data.batchId;
    assert.deepEqual(up.json.data.preview.tagging, expectedSummary);
    assert.equal(up.json.data.preview.newLeads, 11);
    assert.ok(!up.json.data.unrecognized.includes("Tagging"));
    assert.equal((await api("admin", "GET", `/lead/leads/import/${batchId}/progress`)).json.data.tagging, null, "nothing is imported yet");
  });

  it("a manual column choice cannot move the status away from Tagging", async () => {
    const r = await api("admin", "PATCH", `/lead/leads/import/${batchId}/mapping`, { mapping: { Feedback: "requirement", Tagging: "extra" } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data.preview.tagging, expectedSummary);
    assert.equal((await api("admin", "PATCH", `/lead/leads/import/${batchId}/mapping`, { mapping: { Feedback: "tagging" } })).status, 400, "there is no mapping field for the status");
  });

  it("creates each lead with the status of its Tagging value, whatever Feedback says, and reports the unrecognised value", async () => {
    await api("admin", "POST", `/lead/leads/import/${batchId}/start`, {});
    const p = await finish("admin", batchId);
    assert.deepEqual([p.status, p.created, p.failed], ["COMMITTED", 11, 1]);
    assert.deepEqual(p.tagging, expectedSummary);
    const leads = await prisma.lead.findMany({ where: { importBatchId: batchId }, include: { source: true } });
    assert.equal(leads.length, 11);
    for (const [name, i, tagging, feedback, status] of cases) {
      const lead = leads.find((l) => l.normalizedMobile === e164(i))!;
      assert.equal(lead.workingStatus, status, name);
      assert.deepEqual([lead.firstName, lead.lastName, lead.location, lead.requirement, lead.lifecycleStage], ["Tag", name.slice(4), "Pune", feedback, "LEAD"], name);
      assert.equal(lead.source?.name, "Field visit");
      assert.equal((lead.importData as { extra?: Record<string, string> }).extra?.Tagging, tagging.trim() || undefined, "the file's own text stays on the lead");
    }
    // no reminder is invented for Follow up / Call back: the file has no date
    assert.equal(await prisma.task.count({ where: { leadId: { in: leads.map((l) => l.id) } } }), 0);
  });

  it("a later file with a blank Tagging never changes an existing lead's status", async () => {
    const before = (await prisma.lead.findFirst({ where: { importBatchId: batchId, normalizedMobile: e164(802) } }))!;
    const up = await upload("admin", await xlsx(HEADER, [["Tag Interested", phone(802), "", "", "", "Not interested"]]), "blank-tag.xlsx");
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    assert.equal((await finish("admin", up.json.data.batchId)).status, "COMMITTED");
    const after = (await prisma.lead.findUnique({ where: { id: before.id } }))!;
    assert.deepEqual([after.workingStatus, after.updatedAt.getTime()], ["INTERESTED", before.updatedAt.getTime()]);
  });

  it("a file without a Tagging column works as before", async () => {
    const up = await upload("admin", await xlsx(["Name", "Mobile", "Feedback", "Status"], [["Plain Lead", phone(820), "Interested", "Busy"]]), "plain.xlsx");
    assert.equal(up.json.data.preview.tagging, null);
    await api("admin", "POST", `/lead/leads/import/${up.json.data.batchId}/start`, {});
    const p = await finish("admin", up.json.data.batchId);
    assert.deepEqual([p.status, p.tagging], ["COMMITTED", null]);
    assert.equal((await prisma.lead.findFirst({ where: { importBatchId: up.json.data.batchId } }))!.workingStatus, "NEW");
  });
});
