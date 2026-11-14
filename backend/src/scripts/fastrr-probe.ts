// READ-ONLY probe of the Fastrr abandoned-cart report. Makes GET requests to Fastrr only: no database connection, no writes, nothing imported.
//   npm run fastrr:probe -- 2026-11-14 2026-11-14
// Needs FASTRR_REPORTING_AUTH_TOKEN and FASTRR_REPORTING_AUTH_INFO in the environment (.env). Prints STRUCTURE only: page counts, records per page, the set of field names
// (nested too), value TYPES, the shape of timeInitiated and of the address fields, and counts - never a name, phone, email, address or credential.
import "dotenv/config";
import { ABANDONED_CARTS_PATH, loadFastrrRecoveryConfig } from "../modules/fastrr-recovery/fastrr-recovery.config.js";
import { readCartArray, readPaging, validateRange } from "../modules/fastrr-recovery/fastrr-recovery.client.js";

const [from, to] = [process.argv[2] ?? "", process.argv[3] ?? process.argv[2] ?? ""];
const problem = validateRange(from, to);
if (problem) {
  console.error(`usage: npm run fastrr:probe -- YYYY-MM-DD YYYY-MM-DD  (${problem})`);
  process.exit(2);
}
const config = loadFastrrRecoveryConfig();
const MAX = 60;

/** A value reduced to its shape: types and digit/letter patterns, never the content. */
function shape(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return "object";
  if (typeof v === "number") return Number.isInteger(v) ? (v > 1e11 ? "epoch-ms" : v > 1e9 ? "epoch-s" : "int") : "float";
  if (typeof v === "string") return v === "" ? "empty-string" : `string:${v.slice(0, 40).replace(/[A-Za-z]/g, "a").replace(/\d/g, "9")}`.slice(0, 60);
  return typeof v;
}
function walk(v: unknown, path: string, out: Map<string, Map<string, number>>, depth = 0): void {
  if (depth > 4) return;
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 5)) walk(item, `${path}[]`, out, depth + 1);
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      const s = out.get(p) ?? new Map<string, number>();
      const t = Array.isArray(val) || (val && typeof val === "object") ? shape(val) : /address|name|phone|email|mobile/i.test(k) && typeof val === "string" ? (val ? "string(present)" : "empty-string") : shape(val);
      s.set(t, (s.get(t) ?? 0) + 1);
      out.set(p, s);
      walk(val, p, out, depth + 1);
    }
  }
}

const fields = new Map<string, Map<string, number>>();
const seen = new Set<string>();
const perPage: number[] = [];
const topKeys = new Set<string>();
let total = 0;
let dup = 0;
let stop = "page limit";
for (let page = 0; page < MAX; page++) {
  const url = `${config.baseUrl}${ABANDONED_CARTS_PATH}?${new URLSearchParams({ page: String(page), from, to, source: "fastrr" })}`;
  const res = await fetch(url, { headers: { Accept: "application/json", "x-auth": config.authToken, "authentication-info": config.authInfo } });
  if (!res.ok) {
    console.error(`page ${page}: HTTP ${res.status}`);
    stop = `HTTP ${res.status}`;
    break;
  }
  const json: unknown = await res.json();
  const list = readCartArray(json);
  if (!list) {
    console.error(`page ${page}: response has no data.abandonCarts. Top-level keys: ${Object.keys((json as object) ?? {}).join(", ")}`);
    stop = "malformed";
    break;
  }
  if (page === 0) {
    const root = (json ?? {}) as Record<string, unknown>;
    const data = (root.data ?? {}) as Record<string, unknown>;
    console.log("response keys:", Object.keys(root).join(", "), "| data keys:", Object.keys(data).join(", "));
    for (const [k, v] of Object.entries({ ...root, ...data })) if (typeof v !== "object") console.log(`  scalar ${k} = ${typeof v === "string" && v.length > 30 ? "(long string)" : String(v)}`);
    console.log("paging fields the client understood:", JSON.stringify(readPaging(json)));
  }
  perPage.push(list.length);
  if (list.length === 0) { stop = "empty page"; break; }
  let fresh = 0;
  for (const rec of list) {
    walk(rec, "", fields);
    for (const k of Object.keys((rec ?? {}) as object)) topKeys.add(k);
    const id = String(((rec ?? {}) as Record<string, unknown>).cart ?? "");
    if (id && seen.has(id)) dup++;
    else { seen.add(id); fresh++; }
    total++;
  }
  if (fresh === 0) { stop = "page repeated (endpoint ignores `page`?)"; break; }
}
console.log(`\nrange ${from}..${to}: pages read=${perPage.length} records/page=[${perPage.join(",")}] total records=${total} distinct cart ids=${seen.size} repeated=${dup} stopped: ${stop}`);
console.log("\nfield -> value shapes (count across first records)");
for (const [path, shapes] of [...fields.entries()].sort()) console.log(`  ${path}: ${[...shapes.entries()].map(([s, n]) => `${s} x${n}`).join(" | ")}`);
console.log("\naddress-like fields:", [...fields.keys()].filter((k) => /addr|city|state|pin|zip|landmark|country/i.test(k)).join(", ") || "NONE FOUND");
