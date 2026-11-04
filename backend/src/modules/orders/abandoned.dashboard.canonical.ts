import { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { cartItemsKey } from "@/lib/checkoutCartKey.js";

// CANONICAL CHECKOUT RULE for the Abandoned Checkouts dashboard (total, cards, open-cart value, previous-period comparison, list, Excel export AND the trend chart all use it). Shiprocket gives a customer a NEW cart id
// every time they re-enter checkout, so one real checkout can be stored as several rows. For one lead and one cart (same item list, order-independent and never empty; same cart value, present), in detection order:
//   - the first OPEN row is CANONICAL; it keeps its checkout id, assignment, notes and history;
//   - a later row detected within CANONICAL_WINDOW_MINUTES of that CANONICAL row (inclusive) is a DUPLICATE and is not counted or listed;
//   - a later row further than the window from the canonical row starts a NEW canonical checkout - the window is anchored on the canonical row and never slides, so a chain of carts each within 60 minutes of the previous
//     one cannot silently collapse hours of re-entries into one. Such a chain is flagged "ambiguous" by the dry-run report for manual review.
// Names, phones or products alone never make a duplicate. Nothing is deleted or merged: this is a read filter. (Ingestion uses the same window for new deliveries: shiprocket.abandonment.processor.ts.)

export const CANONICAL_WINDOW_MINUTES = 60;
const WINDOW_MS = CANONICAL_WINDOW_MINUTES * 60_000;

const value = Prisma.sql`(CASE WHEN a.cart_snapshot->>'cartValue' ~ '^[0-9]+([.][0-9]+)?$' THEN (a.cart_snapshot->>'cartValue')::numeric END)`;

export interface CheckoutRow { id: string; leadId: string; at: Date; open: boolean; key: string; day?: string; ref?: string | null }
export interface Classified { canonical: CheckoutRow; duplicates: CheckoutRow[]; ambiguous: boolean }

/** Pure and deterministic (rows are ordered by time then id): groups rows of the same lead + cart into canonical checkouts and their duplicates. `ambiguous` = a duplicate-looking chain: a later row is within the window of
 *  an EARLIER DUPLICATE but not of the canonical row, so it was kept as its own checkout and needs a human look. */
export function classifyCheckouts(rows: readonly CheckoutRow[]): Classified[] {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const byKey = new Map<string, CheckoutRow[]>();
  for (const r of sorted) byKey.set(`${r.leadId}|${r.key}`, [...(byKey.get(`${r.leadId}|${r.key}`) ?? []), r]);
  const out: Classified[] = [];
  for (const group of byKey.values()) {
    let current = null as Classified | null;
    let last = null as CheckoutRow | null; // the most recent row of this lead + cart, duplicate or canonical
    for (const r of group) {
      if (current && current.canonical.open && r.at.getTime() - current.canonical.at.getTime() <= WINDOW_MS) {
        current.duplicates.push(r);
      } else {
        if (current) out.push(current);
        // a new canonical row that is within the window of the previous (duplicate) row is a chain beyond the anchored window
        const prevCanonical: CheckoutRow | null = current ? current.canonical : null;
        const chained: boolean = last !== null && last !== prevCanonical && r.at.getTime() - last.at.getTime() <= WINDOW_MS;
        current = { canonical: r, duplicates: [], ambiguous: chained };
      }
      last = r;
    }
    if (current) out.push(current);
  }
  return out;
}

const rowsFor = async (db: Pick<DbClient, "$queryRaw">, from: Date, to: Date, leadIds?: readonly string[]): Promise<CheckoutRow[]> => {
  const onlyLeads = leadIds ? Prisma.sql`AND a.lead_id::text = ANY(${[...leadIds]}::text[])` : Prisma.empty;
  // The contents key comes from the FULL saved item list (see checkoutCartKey.ts), computed here; a cart whose contents cannot be compared safely gets no key and is left out (never merged).
  const rows = await db.$queryRaw<{ id: string; lead_id: string; at: Date; status: string; val: string; ref: string | null; day: string; items: unknown; names: unknown; item_count: string | null }[]>(Prisma.sql`
    SELECT a.id::text AS id, a.lead_id::text AS lead_id, a.detected_at AS at, a.status::text AS status, a.reference_id AS ref, ${value}::text AS val,
           a.cart_snapshot->'items' AS items, a.cart_snapshot->'itemNames' AS names, a.cart_snapshot->>'itemCount' AS item_count,
           to_char((a.detected_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day
    FROM abandonments a
    WHERE a.type = 'CHECKOUT'::abandonment_type AND a.detected_at >= ${from} AND a.detected_at < ${to} AND ${value} IS NOT NULL ${onlyLeads}
    ORDER BY a.lead_id, a.detected_at, a.id`);
  return rows.flatMap((r) => {
    const contents = cartItemsKey({ items: r.items, itemNames: r.names, itemCount: r.item_count });
    return contents === null ? [] : [{ id: r.id, leadId: r.lead_id, at: new Date(r.at), open: r.status === "ACTIVE" || r.status === "IN_PROGRESS", key: `${contents}|${Number(r.val)}`, day: r.day, ref: r.ref }];
  });
};

/**
 * The rows of [start, end) that are duplicates of an earlier canonical checkout. Read-only.
 * EXACT at the range edge: the anchored window makes a row's status depend on the canonical rows before it (a dense chain alternates canonical / duplicate), so cutting the history at an arbitrary point can flip rows near the cut.
 * Therefore, for every lead that has a row in the range, that lead's WHOLE earlier history is loaded and classified together with the range, and only the range's rows are returned. Leads with nothing in the range cost nothing.
 */
export async function duplicateCheckoutIds(db: Pick<DbClient, "$queryRaw">, range: { start: Date; end: Date }): Promise<string[]> {
  const inRange = await rowsFor(db, range.start, range.end);
  const leads = [...new Set(inRange.map((r) => r.leadId))];
  const history = leads.length > 0 ? await rowsFor(db, new Date(0), range.start, leads) : [];
  const startMs = range.start.getTime();
  return classifyCheckouts([...history, ...inRange]).flatMap((c) => c.duplicates.filter((d) => d.at.getTime() >= startMs).map((d) => d.id));
}

export interface DuplicateGroup {
  day: string;
  canonicalId: string;
  canonicalCheckoutId: string | null;
  duplicates: { id: string; checkoutId: string | null; minutesAfterCanonical: number }[];
  evidence: string;
  safeToCollapse: boolean;
  note: string | null;
}

/** READ-ONLY report of the existing duplicate groups (nothing is changed). Every group lists the canonical record and its duplicates. `safeToCollapse` is false (manual review) for a chain beyond the anchored window
 *  (the next canonical checkout that follows a duplicate within 60 minutes), or when a member is not open. */
export async function duplicateReport(db: Pick<DbClient, "$queryRaw">, range: { start: Date; end: Date }): Promise<DuplicateGroup[]> {
  const rows = await rowsFor(db, range.start, range.end);
  const out: DuplicateGroup[] = [];
  for (const c of classifyCheckouts(rows)) {
    if (c.duplicates.length === 0 && !c.ambiguous) continue;
    const dups = c.duplicates.map((d) => ({ id: d.id, checkoutId: d.ref ?? null, minutesAfterCanonical: Math.round((d.at.getTime() - c.canonical.at.getTime()) / 60_000) }));
    out.push({
      day: c.canonical.day ?? "",
      canonicalId: c.canonical.id,
      canonicalCheckoutId: c.canonical.ref ?? null,
      duplicates: dups,
      evidence: dups.length > 0 ? `same lead, same item list, same cart value; ${dups.length} later row${dups.length === 1 ? "" : "s"} with a different cart id within ${Math.max(...dups.map((d) => d.minutesAfterCanonical))} min of the canonical row` : "same lead, item list and value as an earlier duplicate, but more than 60 minutes after its canonical row",
      safeToCollapse: !c.ambiguous && c.canonical.open,
      note: c.ambiguous ? "chain: this checkout follows a duplicate within 60 min but is beyond 60 min from the canonical row - kept separate; review manually" : !c.canonical.open ? "canonical row is not open (recovered / closed) - review manually" : null,
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.canonicalId.localeCompare(b.canonicalId));
}

// The Abandoned Leads list reloads often and classifies from its first day, which costs ~0.5-0.9 s on 12.5k rows and grows with the table. Duplicates change slowly (a new re-entry), so the list may use a result up to
// CACHE_TTL_MS old. The window is ALWAYS open-ended (from `start` to tomorrow), so the key is the exact start only: a different start is a different entry and a result never covers less than was asked for.
// Keyed per database client (the app's shared client in production; every test transaction is its own client, so tests never see another test's result).
const CACHE_TTL_MS = 60_000;
const cache = new WeakMap<object, Map<number, { at: number; ids: string[] }>>();
export async function cachedDuplicateCheckoutIds(db: Pick<DbClient, "$queryRaw">, from: { start: Date }, now: () => number = Date.now): Promise<string[]> {
  const perDb = cache.get(db) ?? new Map<number, { at: number; ids: string[] }>();
  cache.set(db, perDb);
  const key = from.start.getTime();
  const hit = perDb.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.ids;
  const ids = await duplicateCheckoutIds(db, { start: from.start, end: new Date(now() + 86_400_000) });
  perDb.set(key, { at: now(), ids });
  if (perDb.size > 50) for (const k of [...perDb.keys()].slice(0, perDb.size - 50)) perDb.delete(k); // bounded
  return ids;
}
