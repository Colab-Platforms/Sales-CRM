// READ-ONLY validation of whether Shiprocket/Fastrr `cart_token` could safely identify "the same checkout" across changing cart ids. It measures; it matches and changes nothing.
//   npx tsx src/scripts/cart-token-validation.ts --expect-host=<exact db host> [--cap=50000] [--record-ids=<uuid>,<uuid>] [--json]
// Safety: SELECT-only queries (each checked by assertSelectOnly), run inside BEGIN READ ONLY on a session with default_transaction_read_only = on, rolled back, and only after the
// target host EXACTLY matches --expect-host. Tokens, cart ids and contact details are fingerprinted/compared inside PostgreSQL and never selected; only aggregate counts, 8-char
// fingerprints, timestamps and event ids are returned or printed. Errors are reported as a generic line plus the error code.
import "dotenv/config";
// @ts-expect-error pg ships no type declarations in this project
const pg: any = (await import("pg")).default;
import { hostMatches, parseTarget } from "./duplicate-leads-report.safety.js";
import { assertSelectOnly } from "./abandonment-duplicates-report.logic.js";
import { validateRecordIds } from "./abandonment-webhook-correlation.logic.js";
import {
  ALL_SQL, CARTS_DETAIL_SQL, CARTS_SQL, COVERAGE_SQL, FINGERPRINT_METHOD, FORMAT_SQL, OBSERVED_SQL, PRESENCE_SQL, READ_SETUP, TOKENS_SQL,
  assessCoverage, associationStats, cardinalityStats, clampCap, lifetimeStats, observedPair, recommend, sharingStats, summarizeFormat, summarizePresence, toTokenView,
  type CartsRow, type CoverageRow, type FormatRow, type ObservedRow, type PresenceRow, type TokenRow,
} from "./cart-token-validation.logic.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
const asJson = process.argv.includes("--json");
const cap = clampCap(arg("cap"));
const rawRecordIds = arg("record-ids");
const recordIds = rawRecordIds === undefined ? null : validateRecordIds(rawRecordIds.split(",").map((s) => s.trim()).filter(Boolean));
const TOKEN_ROW_CAP = 100_000;

if (rawRecordIds !== undefined && !recordIds) {
  console.error("--record-ids must be 1-10 valid UUIDs, comma separated.");
  process.exit(2);
}

const connectionString = process.env.REPORT_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const target = parseTarget(connectionString);
if (!target.ok) {
  console.error("The configured database URL is missing or malformed. Check it in your environment (it is not printed here).");
  process.exit(2);
}
console.log(`Target database: host=${target.host.replace("-pooler", "")} db=${target.db}`);
if (!hostMatches(target.host, arg("expect-host"))) {
  console.log("Refusing to run: pass --expect-host=<the exact host name you intend to inspect> to confirm the target above.");
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
} catch (error) {
  console.error(`Could not connect to the database (${(error as { code?: string })?.code ?? "unknown error"}).`);
  process.exit(2);
}

let coverageRow: CoverageRow | undefined;
let presenceRows: PresenceRow[] = [];
let formatRows: FormatRow[] = [];
let tokenRows: TokenRow[] = [];
let cartsRow: CartsRow | undefined;
let cartDetail: { cart_fp: string; n_tokens: number | string; n_events: number | string; first_at: Date; last_at: Date }[] = [];
let observedRows: ObservedRow[] = [];
try {
  await client.query("SET default_transaction_read_only = on");
  for (const stmt of READ_SETUP) await client.query(stmt);
  for (const sql of ALL_SQL) assertSelectOnly(sql);
  coverageRow = (await client.query(COVERAGE_SQL, [cap])).rows[0];
  presenceRows = (await client.query(PRESENCE_SQL, [cap])).rows;
  formatRows = (await client.query(FORMAT_SQL, [cap])).rows;
  tokenRows = (await client.query(TOKENS_SQL, [cap, TOKEN_ROW_CAP])).rows;
  cartsRow = (await client.query(CARTS_SQL, [cap])).rows[0];
  cartDetail = (await client.query(CARTS_DETAIL_SQL, [cap])).rows;
  if (recordIds) observedRows = (await client.query(OBSERVED_SQL, [cap, recordIds])).rows;
  await client.query("ROLLBACK");
} catch (error) {
  console.error(`Query failed (${(error as { code?: string })?.code ?? "unknown error"}). Nothing was changed.`);
  process.exit(2);
} finally {
  await client.end().catch(() => undefined);
}

const coverage = assessCoverage(coverageRow ?? { total_events: 0, total_oldest: null, sample_events: 0, sample_oldest: null, sample_newest: null, events_with_contact: 0, events_with_lead: 0 }, cap);
const presence = summarizePresence(presenceRows);
const format = summarizeFormat(formatRows, presence.token.ok);
const tokens = tokenRows.map(toTokenView);
const lifetime = lifetimeStats(tokens);
const sharing = sharingStats(tokens);
const cardinality = cardinalityStats(tokens, cartsRow ?? null);
const association = associationStats(tokens);
const observed = recordIds ? observedPair(observedRows) : null;
const recommendation = recommend({ coverage, presence, format, lifetime, sharing, association, tokenRowsTruncated: tokenRows.length >= TOKEN_ROW_CAP });
const topShared = tokens.filter((t) => t.leads > 1 || t.contacts > 1).slice(0, 20);

if (asJson) {
  console.log(JSON.stringify({ fingerprintMethod: FINGERPRINT_METHOD, coverage, presence, format, lifetime, sharing, cardinality, association, observed, topSharedTokens: topShared, recommendation }, null, 2));
  process.exit(0);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log("READ-ONLY validation - nothing was changed. Fingerprints: " + FINGERPRINT_METHOD + ".\n");
console.log("== 1. Coverage");
console.log(`Examined ${coverage.sampleEvents} of ${coverage.totalEvents} stored checkout.abandoned events (cap ${coverage.sampleCap}${coverage.capReached ? " - CAP REACHED, results are INCOMPLETE" : ""}); range ${coverage.oldest ?? "n/a"} .. ${coverage.newest ?? "n/a"} (${coverage.rangeDays ?? "n/a"} days).`);
console.log(`Events with a phone/email: ${pct(coverage.eventsWithContactShare)}; events tied to a lead: ${pct(coverage.eventsWithLeadShare)}.`);
console.log("\n== 2. Presence and format");
console.table({ cart_token: presence.token, cart_id: presence.cartId });
console.log(`Well-formed token shapes: ${format.distinctShapes}; dominant ${format.dominant ? `${format.dominant.charset}/${format.dominant.length} chars (${pct(format.dominant.share)})` : "n/a"}; consistent: ${format.consistent}`);
console.table(format.distribution.slice(0, 10));
console.log("\n== 3. Cross-customer sharing (observed in this window only)");
console.table(sharing);
if (topShared.length) console.table(topShared.map((t) => ({ token_fp: t.fp, events: t.events, leads: t.leads, contacts: t.contacts, first: t.firstAt, last: t.lastAt })));
console.log("\n== 4. Token lifetime");
console.table(lifetime.buckets);
console.log({ ...lifetime, buckets: undefined });
console.log("\n== 5. Token / cart-id cardinality");
console.log(cardinality);
if (cartDetail.length) console.table(cartDetail);
console.log("\n== 6. Overlap with orders and abandonment closures (single-lead tokens only; time co-occurrence, not causation)");
console.log(association);
if (observed) {
  console.log("\n== 7. The observed records");
  console.log({ found: observed.found, sharesToken: observed.sharesToken, tokenFingerprints: observed.tokenFingerprints, note: observed.note });
  if (observed.found) console.table(observed.events);
}
console.log(`\n== RESULT: ${recommendation.verdict}`);
for (const r of recommendation.reasons) console.log(`  - ${r}`);
console.log("\nLimitations:");
for (const l of recommendation.limitations) console.log(`  - ${l}`);
