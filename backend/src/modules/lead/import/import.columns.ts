import { createHash } from "node:crypto";
import { normalizeEmail, normalizeMobile } from "@/lib/leadIdentity.js";
import { parseOrderCount, type OrderCountParse } from "@/lib/customerClass.js";

// COLUMN DETECTION AND ROW READING for customer files (Excel / CSV). Pure functions: no database, no file access.
// A header is matched by its normalised text (lower case, letters and digits only) against a table of well-known names, then by a few conservative keyword rules. A column nobody recognises is NOT dropped: it is kept as
// "extra" data on the lead under its own header, and the user may still map it by hand.

export const IMPORT_FIELDS = ["fullName", "firstName", "lastName", "mobile", "email", "orderCount", "totalOrdersValue", "city", "state", "address", "pincode", "product", "lastOrderDate", "paymentInfo", "requirement", "location", "sourceName", "extra"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Record<string, ImportField>;

const SYNONYMS: Record<Exclude<ImportField, "extra">, string[]> = {
  fullName: ["name", "customername", "fullname", "customer", "clientname", "buyername", "contactname", "billingname", "shippingname", "leadname", "custname", "nameofcustomer"],
  firstName: ["firstname", "fname", "givenname", "first"],
  lastName: ["lastname", "surname", "lname", "familyname", "last"],
  mobile: ["phone", "phonenumber", "mobile", "mobilenumber", "mobileno", "phoneno", "contact", "contactnumber", "contactno", "whatsapp", "whatsappnumber", "whatsappno", "cell", "cellphone", "telephone", "customerphone", "customermobile", "billingphone", "shippingphone", "mobilephone", "phonenum", "mob", "mobno"],
  email: ["email", "emailid", "emailaddress", "mail", "customeremail", "emailids", "mailid"],
  orderCount: ["ordercount", "totalorders", "totalordercount", "noorders", "noofoders", "nooforders", "numberoforders", "orders", "ordersplaced", "ordercnt", "orderscount", "purchasecount", "timesordered", "numorders", "totalnumberoforders", "ordersnumber", "orderqty", "totalorder"],
  totalOrdersValue: ["totalordersvalue", "totalordervalue", "totalspent", "totalspend", "ordersvalue", "ordervalue", "ltv", "lifetimevalue", "totalrevenue", "revenue", "amountspent", "totalsales", "totalpurchasevalue", "totalamountspent", "totalpurchase", "ordersamount", "totalordersamount", "totalorderamount"],
  city: ["city", "town", "shippingcity", "billingcity", "cityname"],
  state: ["state", "province", "region", "shippingstate", "billingstate", "statename"],
  address: ["address", "fulladdress", "streetaddress", "address1", "addressline1", "shippingaddress", "billingaddress", "customeraddress", "deliveryaddress"],
  pincode: ["pincode", "pin", "zip", "zipcode", "postalcode", "postcode", "pinno"],
  product: ["product", "products", "productname", "productinfo", "productinformation", "items", "itemname", "lastproduct", "lineitems", "productsordered", "productdetails", "productsbought", "sku"],
  lastOrderDate: ["lastorderdate", "lastorder", "lastpurchasedate", "lastorderedon", "recentorderdate", "latestorderdate", "lastorderat", "lastpurchase", "dateoflastorder", "lastorderon"],
  paymentInfo: ["payment", "paymentmode", "paymentmethod", "paymentstatus", "paymentinfo", "paymenttype", "paymentgateway", "paymentdetails", "paymentinformation"],
  requirement: ["requirement", "notes", "remarks", "comment", "comments", "note"],
  location: ["location"],
  sourceName: ["source", "leadsource", "sourcename"],
};

const EXACT = new Map<string, ImportField>();
for (const [field, names] of Object.entries(SYNONYMS)) for (const n of names) if (!EXACT.has(n)) EXACT.set(n, field as ImportField);

export const normalizeHeader = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Conservative keyword rules for headers the table does not list ("Customer Mobile No.", "Total No. of Orders"). */
function likelyField(key: string): ImportField | null {
  if (/(phone|mobile|whatsapp)/.test(key) && !/(alt|alternate|secondary|other|2$)/.test(key)) return "mobile";
  if (/e?mail/.test(key) && !/(alt|alternate|secondary)/.test(key)) return "email";
  if (/(pincode|postal|zipcode)/.test(key)) return "pincode";
  if (/city/.test(key)) return "city";
  if (/state$/.test(key) || /^state/.test(key)) return "state";
  if (/address/.test(key)) return "address";
  if (/^ltv/.test(key) || /(lifetimevalue|totalspen|amountspent|totalrevenue)/.test(key)) return "totalOrdersValue";
  if (/order/.test(key) && /(value|amount|spent|spend|revenue)/.test(key)) return "totalOrdersValue";
  if (/order/.test(key) && /(date|on$|at$)/.test(key)) return "lastOrderDate";
  if (/order/.test(key) && /(count|no|number|total|num|qty|cnt)/.test(key)) return "orderCount";
  if (/product|item/.test(key)) return "product";
  if (/payment/.test(key)) return "paymentInfo";
  return null;
}

export type DetectedColumn = {
  header: string;
  field: ImportField;
  /** exact = a known name; likely = recognised by keyword; none = not recognised (kept as extra data). */
  confidence: "exact" | "likely" | "none";
  /** Another column was already mapped to this field: needs the user's decision. */
  conflictWith?: string;
};

export type Detection = { columns: DetectedColumn[]; mapping: ColumnMapping; needsReview: DetectedColumn[]; unrecognized: DetectedColumn[]; signature: string };

/** A fingerprint of the file's header names, so a recurring file format finds its remembered mapping. */
export function headerSignature(headers: readonly string[]): string {
  const keys = headers.map(normalizeHeader).filter(Boolean).sort();
  return createHash("sha256").update(keys.join("|")).digest("hex");
}

const SINGLE: ImportField[] = ["fullName", "firstName", "lastName", "mobile", "email", "orderCount", "totalOrdersValue", "city", "state", "address", "pincode", "product", "lastOrderDate", "paymentInfo", "requirement", "location", "sourceName"];

export function detectColumns(headers: readonly string[], remembered?: ColumnMapping | null): Detection {
  const taken = new Map<ImportField, string>();
  const columns: DetectedColumn[] = [];
  for (const header of headers) {
    const key = normalizeHeader(header);
    const rememberedField = remembered?.[header];
    let field: ImportField = "extra";
    let confidence: DetectedColumn["confidence"] = "none";
    if (rememberedField && (IMPORT_FIELDS as readonly string[]).includes(rememberedField)) {
      field = rememberedField;
      confidence = "exact";
    } else if (EXACT.has(key)) {
      field = EXACT.get(key)!;
      confidence = "exact";
    } else {
      const guess = likelyField(key);
      if (guess) {
        field = guess;
        confidence = "likely";
      }
    }
    const col: DetectedColumn = { header, field, confidence };
    if (field !== "extra" && SINGLE.includes(field)) {
      const prior = taken.get(field);
      if (prior !== undefined) {
        // two columns for one field (e.g. "Phone" and "Mobile No"): the first keeps it, the second is ambiguous and is kept as extra data until the user decides
        col.conflictWith = prior;
        col.field = "extra";
      } else taken.set(field, header);
    }
    columns.push(col);
  }
  // "Name" next to "First name": the pair wins and the combined column is the ambiguous one
  if (taken.has("fullName") && (taken.has("firstName") || taken.has("lastName"))) {
    const fn = columns.find((c) => c.header === taken.get("fullName"));
    if (fn && !remembered) {
      fn.field = "extra";
      fn.conflictWith = taken.get("firstName") ?? taken.get("lastName");
    }
  }
  const mapping: ColumnMapping = {};
  for (const c of columns) mapping[c.header] = c.field;
  return {
    columns,
    mapping,
    needsReview: columns.filter((c) => c.conflictWith !== undefined),
    unrecognized: columns.filter((c) => c.field === "extra" && c.conflictWith === undefined && c.confidence === "none"),
    signature: headerSignature(headers),
  };
}

// ----------------------------------------------------------------------------------------------- cell values

const clean = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/** A phone number from a cell: Excel often turns it into a number (9876543210, 9.87654321E9, "9876543210.0"). */
export function cleanPhone(raw: string): string {
  const t = raw.trim();
  if (/^\d+\.0+$/.test(t)) return t.replace(/\.0+$/, "");
  if (/^\d(\.\d+)?e\+?\d+$/i.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n.toFixed(0);
  }
  // several numbers in one cell ("9876543210 / 9123456789"): the first is the customer's
  const first = t.split(/[/,;|\n]/).map((s) => s.trim()).find((s) => s.replace(/\D/g, "").length >= 8);
  return first ?? t;
}

/** "Rs. 1,23,456.50", "1,200" -> number; anything else null. */
export function parseMoney(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const cleaned = t.replace(/(₹|rs\.?|inr)/gi, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n < 1e12 ? Math.round(n * 100) / 100 : null;
}

const dateOnly = (y: number, mo: number, d: number): Date | null => {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCDate() === d && date.getUTCMonth() === mo - 1 ? date : null;
};

/** ISO yyyy-mm-dd[Thh:mm...], dd/mm/yyyy (day first, the Indian convention) or "12 Nov 2026" -> Date; anything else null. */
export function parseLooseDate(raw: string): Date | null {
  const t = raw.trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (m) {
    if (!dateOnly(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
    const parsed = new Date(t.includes("T") || t.includes(":") ? t : `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) return dateOnly(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  if (/[a-z]/i.test(t)) {
    const parsed = new Date(t);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2000 && parsed.getFullYear() <= 2100) return parsed;
  }
  return null;
}

// ----------------------------------------------------------------------------------------------- one row

export type ParsedCustomer = {
  firstName: string;
  nameMissing: boolean;
  lastName: string | null;
  mobile: string | null;
  normalizedMobile: string | null;
  phonePresentButInvalid: boolean;
  email: string | null;
  normalizedEmail: string | null;
  orderCount: OrderCountParse;
  totalOrdersValue: number | null;
  lastOrderAt: Date | null;
  city: string | null;
  state: string | null;
  address: string | null;
  pincode: string | null;
  product: string | null;
  paymentInfo: string | null;
  requirement: string | null;
  location: string | null;
  sourceName: string | null;
  /** Columns the CRM has no field for (and unrecognised ones), by their own header. */
  extra: Record<string, string>;
};

/** The first non-empty value among all columns mapped to `field`. */
function pick(cells: Record<string, string>, mapping: ColumnMapping, field: ImportField): string {
  for (const [header, f] of Object.entries(mapping)) {
    if (f !== field) continue;
    const v = clean(cells[header]);
    if (v) return v;
  }
  return "";
}

export function readCustomer(cells: Record<string, string>, mapping: ColumnMapping): ParsedCustomer {
  const full = pick(cells, mapping, "fullName");
  let first = pick(cells, mapping, "firstName");
  let last = pick(cells, mapping, "lastName");
  if (!first && full) {
    const parts = full.split(/\s+/);
    first = parts[0]!;
    if (!last) last = parts.slice(1).join(" ");
  }
  const rawPhone = pick(cells, mapping, "mobile");
  const phone = rawPhone ? cleanPhone(rawPhone) : "";
  const normalizedMobile = phone ? normalizeMobile(phone) : null;
  const email = pick(cells, mapping, "email");
  const normalizedEmail = email ? normalizeEmail(email) : null;
  const moneyRaw = pick(cells, mapping, "totalOrdersValue");
  const dateRaw = pick(cells, mapping, "lastOrderDate");
  const city = pick(cells, mapping, "city");
  const state = pick(cells, mapping, "state");
  const location = pick(cells, mapping, "location") || [city, state].filter(Boolean).join(", ");
  const extra: Record<string, string> = {};
  for (const [header, f] of Object.entries(mapping)) {
    const v = clean(cells[header]);
    if (f === "extra" && v) extra[header] = v.slice(0, 1000);
  }
  return {
    firstName: (first || "Customer").slice(0, 100),
    nameMissing: !first,
    lastName: last ? last.slice(0, 100) : null,
    mobile: phone ? phone.slice(0, 20) : null,
    normalizedMobile,
    phonePresentButInvalid: Boolean(phone) && !normalizedMobile,
    email: email ? email.slice(0, 255) : null,
    normalizedEmail,
    orderCount: parseOrderCount(pick(cells, mapping, "orderCount")),
    totalOrdersValue: moneyRaw ? parseMoney(moneyRaw) : null,
    lastOrderAt: dateRaw ? parseLooseDate(dateRaw) : null,
    city: city || null,
    state: state || null,
    address: pick(cells, mapping, "address") || null,
    pincode: pick(cells, mapping, "pincode") || null,
    product: pick(cells, mapping, "product") || null,
    paymentInfo: pick(cells, mapping, "paymentInfo") || null,
    requirement: pick(cells, mapping, "requirement") || null,
    location: location ? location.slice(0, 255) : null,
    sourceName: pick(cells, mapping, "sourceName") || null,
    extra,
  };
}

/** Why a row cannot be imported at all (null = importable). A row needs a usable phone number or email: that is how a customer is recognised. */
export function rowProblem(c: ParsedCustomer): string | null {
  if (!c.normalizedMobile && !c.normalizedEmail) {
    if (c.phonePresentButInvalid) return "Phone number is not valid";
    if (c.email) return "Email is not valid and there is no phone number";
    return "No phone number or email";
  }
  return null;
}
