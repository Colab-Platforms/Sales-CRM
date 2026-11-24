import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { classifyCustomer, parseOrderCount } from "@/lib/customerClass.js";
import { cleanPhone, detectColumns, headerSignature, parseLooseDate, parseMoney, readCustomer, rowProblem, type ColumnMapping } from "./import.columns.js";
import { cellText, fileKind, readRows, uniqueHeaders } from "./import.file.js";
import { buildImportData, mergeImportData } from "./import.runner.js";
import { csvCell } from "./import.service.js";

describe("customer classification (by real order count)", () => {
  it("2 = Repeat, 3-4 = Loyal, 5+ = VIP, otherwise not classified", () => {
    const cases: [number | null | undefined, string | null][] = [[2, "REPEAT"], [3, "LOYAL"], [4, "LOYAL"], [5, "VIP"], [17, "VIP"], [1, null], [0, null], [null, null], [undefined, null], [-3, null], [2.5, null]];
    for (const [n, expected] of cases) assert.equal(classifyCustomer(n), expected, String(n));
  });
  it("parses an order count strictly; missing and invalid are different and never guessed", () => {
    assert.deepEqual(parseOrderCount("3"), { state: "ok", value: 3 });
    assert.deepEqual(parseOrderCount(" 4.0 "), { state: "ok", value: 4 });
    assert.deepEqual(parseOrderCount("1,204"), { state: "ok", value: 1204 });
    for (const empty of ["", "   ", "-", null, undefined]) assert.equal(parseOrderCount(empty).state, "missing");
    for (const bad of ["abc", "2.5", "-1", "3 orders", "1e3", "NaN", "999999999"]) assert.equal(parseOrderCount(bad).state, "invalid", bad);
  });
  it("is derived from the order count column, never from the number of rows", () => {
    // three rows for the same customer with order count 1 each is still not classified
    const mapping: ColumnMapping = { Phone: "mobile", Orders: "orderCount" };
    for (let i = 0; i < 3; i++) {
      const c = readCustomer({ Phone: "9876543210", Orders: "1" }, mapping);
      assert.equal(classifyCustomer(c.orderCount.state === "ok" ? c.orderCount.value : null), null);
    }
  });
});

describe("automatic column detection", () => {
  const detect = (headers: string[]) => detectColumns(headers).mapping;

  it("recognises the common header variations without manual mapping", () => {
    const m = detect(["Customer Name", "Phone Number", "Email ID", "Total Orders", "Total Orders Value", "City", "State", "Address", "Product Name", "Last Order Date", "Payment Mode"]);
    assert.deepEqual(m, { "Customer Name": "fullName", "Phone Number": "mobile", "Email ID": "email", "Total Orders": "orderCount", "Total Orders Value": "totalOrdersValue", City: "city", State: "state", Address: "address", "Product Name": "product", "Last Order Date": "lastOrderDate", "Payment Mode": "paymentInfo" });
  });
  it("handles other spellings, case and punctuation", () => {
    const m = detect(["NAME", "mobile_no", "E-mail", "No. of Orders", "LTV", "Pin Code", "last_purchase_date", "Customer Mobile No."]);
    assert.equal(m.NAME, "fullName");
    assert.equal(m.mobile_no, "mobile");
    assert.equal(m["E-mail"], "email");
    assert.equal(m["No. of Orders"], "orderCount");
    assert.equal(m.LTV, "totalOrdersValue");
    assert.equal(detect(["Phone", "LTV (Rs)"])["LTV (Rs)"], "totalOrdersValue");
    assert.equal(detect(["Phone", "Lifetime Value (INR)"])["Lifetime Value (INR)"], "totalOrdersValue");
    assert.equal(m["Pin Code"], "pincode");
    assert.equal(m.last_purchase_date, "lastOrderDate");
    // second phone column is ambiguous: it is kept (as extra) and flagged, never dropped
    assert.equal(m["Customer Mobile No."], "extra");
  });
  it("keeps unrecognised columns as extra data and lists them, never discarding them", () => {
    const d = detectColumns(["Phone", "Favourite Colour", "Loyalty Card No"]);
    assert.equal(d.mapping["Favourite Colour"], "extra");
    assert.deepEqual(d.unrecognized.map((c) => c.header), ["Favourite Colour", "Loyalty Card No"]);
    assert.equal(Object.keys(d.mapping).length, 3);
  });
  it("flags two columns competing for one field as needing review", () => {
    const d = detectColumns(["Phone", "Mobile", "Name"]);
    assert.equal(d.mapping.Phone, "mobile");
    assert.equal(d.needsReview.length, 1);
    assert.equal(d.needsReview[0]!.header, "Mobile");
    assert.equal(d.needsReview[0]!.conflictWith, "Phone");
  });
  it("prefers First/Last name over a combined Name column", () => {
    const d = detectColumns(["Name", "First Name", "Last Name", "Phone"]);
    assert.equal(d.mapping["First Name"], "firstName");
    assert.equal(d.mapping.Name, "extra");
  });
  it("applies a remembered mapping, and the signature ignores column order and case", () => {
    assert.equal(headerSignature(["Phone", "Name", "Orders"]), headerSignature(["orders", "PHONE", "name"]));
    assert.notEqual(headerSignature(["Phone", "Name"]), headerSignature(["Phone", "Name", "City"]));
    const remembered: ColumnMapping = { "Weird Col": "city", Phone: "mobile" };
    const d = detectColumns(["Phone", "Weird Col"], remembered);
    assert.equal(d.mapping["Weird Col"], "city");
  });
});

describe("reading a row", () => {
  const mapping: ColumnMapping = { Name: "fullName", Phone: "mobile", Email: "email", Orders: "orderCount", Spent: "totalOrdersValue", City: "city", State: "state", Product: "product", Last: "lastOrderDate", Note: "extra" };

  it("reads every field, splits the name, joins city and state into the location and keeps extra columns", () => {
    const c = readCustomer({ Name: "Rahul Kumar Sharma", Phone: "98765 43210", Email: "Rahul@Example.com", Orders: "5", Spent: "Rs. 12,345.50", City: "Pune", State: "MH", Product: "Herbal Tea", Last: "12/11/2026", Note: "likes mornings" }, mapping);
    assert.equal(c.firstName, "Rahul");
    assert.equal(c.lastName, "Kumar Sharma");
    assert.equal(c.normalizedMobile, "+919876543210");
    assert.equal(c.normalizedEmail, "rahul@example.com");
    assert.deepEqual(c.orderCount, { state: "ok", value: 5 });
    assert.equal(c.totalOrdersValue, 12345.5);
    assert.equal(c.location, "Pune, MH");
    assert.equal(c.lastOrderAt?.toISOString().slice(0, 10), "2026-11-12"); // day first
    assert.deepEqual(c.extra, { Note: "likes mornings" });
    assert.deepEqual(buildImportData(c), { fields: { city: "Pune", state: "MH", product: "Herbal Tea", lastOrderDate: "2026-11-12" }, extra: { Note: "likes mornings" } });
  });
  it("cleans phone numbers Excel mangled", () => {
    assert.equal(cleanPhone("9876543210.0"), "9876543210");
    assert.equal(cleanPhone("9.876543210E9"), "9876543210");
    assert.equal(cleanPhone("9876543210 / 9123456789"), "9876543210");
    assert.equal(readCustomer({ Phone: "919876543210" }, { Phone: "mobile" }).normalizedMobile, "+919876543210");
  });
  it("money and dates: valid, invalid and ambiguous", () => {
    assert.equal(parseMoney("₹1,23,456.5"), 123456.5);
    assert.equal(parseMoney("abc"), null);
    assert.equal(parseMoney("-5"), null);
    assert.equal(parseLooseDate("2026-11-12")?.toISOString().slice(0, 10), "2026-11-12");
    assert.equal(parseLooseDate("31/02/2026"), null);
    assert.equal(parseLooseDate("not a date"), null);
    assert.equal(parseLooseDate("12 Nov 2026")?.getFullYear(), 2026);
  });
  it("a row needs a usable phone or email, and says why when it has none", () => {
    const m: ColumnMapping = { Phone: "mobile", Email: "email" };
    assert.equal(rowProblem(readCustomer({ Phone: "9876543210" }, m)), null);
    assert.equal(rowProblem(readCustomer({ Email: "a@b.co" }, m)), null);
    assert.equal(rowProblem(readCustomer({ Phone: "12" }, m)), "Phone number is not valid");
    assert.equal(rowProblem(readCustomer({ Email: "nope" }, m)), "Email is not valid and there is no phone number");
    assert.equal(rowProblem(readCustomer({}, m)), "No phone number or email");
  });
  it("a missing name becomes 'Customer' and is flagged, not a reason to reject the row", () => {
    const c = readCustomer({ Phone: "9876543210" }, { Phone: "mobile" });
    assert.equal(c.firstName, "Customer");
    assert.equal(c.nameMissing, true);
  });
});

describe("keeping data on update", () => {
  it("merges new non-empty values over the existing import data and keeps the rest", () => {
    const merged = mergeImportData({ fields: { city: "Pune", product: "Oil" }, extra: { A: "1" } }, { fields: { city: "Mumbai" }, extra: { B: "2" } }, "batch-1");
    assert.deepEqual(merged, { fields: { city: "Mumbai", product: "Oil" }, extra: { A: "1", B: "2" }, lastImportBatchId: "batch-1" });
    assert.equal(mergeImportData({ fields: { city: "Pune" } }, null, "b"), null); // nothing new: leave the stored data alone
  });
});

describe("reading Excel and CSV files", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-test-"));

  it("reads an .xlsx row by row, keeping phone numbers, dates and formulas as text", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Customers");
    ws.addRow(["Customer Name", "Phone", "Total Orders", "Last Order Date", "Total"]);
    ws.addRow(["Asha", 9876543210, 3, new Date("2026-11-12T00:00:00Z"), { formula: "1+1", result: 2 }]);
    ws.addRow([]); // an empty row is skipped
    ws.addRow(["Ravi", "9123456789", "5", "", { richText: [{ text: "Rs " }, { text: "10" }] }]);
    const file = join(dir, "customers.xlsx");
    await wb.xlsx.writeFile(file);
    const rows: string[][] = [];
    for await (const r of readRows(file, "customers.xlsx")) rows.push(r.values);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], ["Customer Name", "Phone", "Total Orders", "Last Order Date", "Total"]);
    assert.equal(rows[1]![1], "9876543210");
    assert.equal(rows[1]![3], "2026-11-12T00:00:00.000Z");
    assert.equal(rows[1]![4], "2");
    assert.equal(rows[2]![4], "Rs 10");
  });
  it("finds the customer table when a cover sheet comes first, and ignores the other sheets", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary").addRow(["Report", "generated 12 Nov"]);
    const ws = wb.addWorksheet("Customers");
    ws.addRow(["Name", "Mobile No.", "Orders"]);
    ws.addRow(["Asha", "9876543210", 3]);
    wb.addWorksheet("Archive").addRow(["Name", "Phone"]);
    const file = join(dir, "multi.xlsx");
    await wb.xlsx.writeFile(file);
    const rows: string[][] = [];
    for await (const r of readRows(file, "multi.xlsx")) rows.push(r.values);
    assert.deepEqual(rows, [["Name", "Mobile No.", "Orders"], ["Asha", "9876543210", "3"]]);
    // no sheet has a phone/email column: the first sheet is used (the import then asks for a column to be mapped)
    const wb2 = new ExcelJS.Workbook();
    wb2.addWorksheet("One").addRow(["City", "Notes"]);
    const f2 = join(dir, "nophone.xlsx");
    await wb2.xlsx.writeFile(f2);
    const r2: string[][] = [];
    for await (const r of readRows(f2, "nophone.xlsx")) r2.push(r.values);
    assert.deepEqual(r2, [["City", "Notes"]]);
  });
  it("reads a CSV with a BOM, quoted commas and a semicolon or tab delimiter", async () => {
    const f1 = join(dir, "a.csv");
    writeFileSync(f1, "﻿Name,Phone,Notes\r\n\"Doe, Jane\",9876543210,\"said \"\"hi\"\"\"\r\n");
    const a: string[][] = [];
    for await (const r of readRows(f1, "a.csv")) a.push(r.values);
    assert.deepEqual(a[0], ["Name", "Phone", "Notes"]);
    assert.deepEqual(a[1], ["Doe, Jane", "9876543210", 'said "hi"']);
    const f2 = join(dir, "b.csv");
    writeFileSync(f2, "Name;Phone\nRavi;9123456789\n");
    const b: string[][] = [];
    for await (const r of readRows(f2, "b.csv")) b.push(r.values);
    assert.deepEqual(b[1], ["Ravi", "9123456789"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("rejects .xls and unknown types with a clear message", () => {
    assert.throws(() => fileKind("old.xls"), /\.xlsx or \.csv/);
    assert.throws(() => fileKind("notes.txt"), /Excel \(\.xlsx\) or CSV/);
    assert.equal(fileKind("A.XLSX"), "xlsx");
    assert.equal(fileKind("A.CSV"), "csv");
  });
  it("makes header names unique and non-empty, and cell values text", () => {
    assert.deepEqual(uniqueHeaders(["Phone", "", "phone", "Phone"]), ["Phone", "Column 2", "phone (2)", "Phone (3)"]);
    assert.equal(cellText(1234567890123), "1234567890123");
    assert.equal(cellText(null), "");
    assert.equal(cellText({ error: "#N/A" }), "");
  });
});

describe("the failed-rows CSV", () => {
  it("neutralises a cell that would run as a formula in Excel and quotes special characters", () => {
    assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
    assert.equal(csvCell("+91 98765"), "'+91 98765");
    assert.equal(csvCell("a,b"), "\"a,b\"");
    assert.equal(csvCell("plain"), "plain");
  });
});
