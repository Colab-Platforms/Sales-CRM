// Pure logic for abandonment-duplicates-report.ts - no I/O, so the query-safety, masking and grouping rules are unit-testable
// without a database. Nothing here ever sees a connection string, a customer name/phone/email or a webhook payload.
import { createHash } from "node:crypto";

// ---- SQL (SELECT-only, parameterised) -------------------------------------------------------------------------------------------------
// Columns come from the Abandonment model (abandonments table). `stage` is read from cart_snapshot->>'stage' (written by the Shiprocket
// processor); rows written before cart_snapshot existed have no stage. Only counts/ids/timestamps/status are selected - never the snapshot itself.
const ROW_COLUMNS = `
  a.id, a.lead_id, l.lead_number, a.type, a.status, a.reference_type, a.reference_id,
  a.cart_snapshot ->> 'stage' as stage,
  a.cart_snapshot ->> 'cartValue' as cart_value,
  a.detected_at, a.created_at, a.updated_at, a.recovered_at,
  (select count(*) from activities ac where ac.reference_type = 'Abandonment' and ac.reference_id = a.id::text) as activity_count,
  (select count(*) from recovery_actions ra where ra.abandonment_id = a.id) as recovery_action_count`;

/** Every CHECKOUT abandonment (any status) of one lead. $1 = lead number. */
export const LEAD_RECORDS_SQL = `select ${ROW_COLUMNS}
  from abandonments a join leads l on l.id = a.lead_id
  where l.lead_number = $1 and a.type = 'CHECKOUT'
  order by a.created_at asc, a.id asc`;

/** Open (ACTIVE / IN_PROGRESS) CHECKOUT abandonments of every lead that has MORE THAN ONE open one. $1 = row limit. */
export const BROAD_OPEN_SQL = `select ${ROW_COLUMNS}
  from abandonments a join leads l on l.id = a.lead_id
  where a.type = 'CHECKOUT' and a.status in ('ACTIVE', 'IN_PROGRESS')
    and a.lead_id in (
      select lead_id from abandonments
      where type = 'CHECKOUT' and status in ('ACTIVE', 'IN_PROGRESS')
      group by lead_id having count(*) > 1)
  order by a.lead_id, a.created_at asc, a.id asc
  limit $1`;

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|merge|vacuum|reindex|lock|set|reset|listen|notify|refresh|comment|security|execute)\b/i;

/** Throws unless `sql` is a single SELECT (or WITH ... SELECT) statement with no write/DDL/session keyword in it. */
export function assertSelectOnly(sql: string): void {
  const text = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
  if (!/^(select|with)\b/i.test(text)) throw new Error("Report query must start with SELECT");
  if (text.includes(";")) throw new Error("Report query must be a single statement");
  // String literals are removed first so a quoted word such as 'ACTIVE' or a column named updated_at cannot trip the check.
  const withoutLiterals = text.replace(/'(?:[^']|'')*'/g, "''");
  const hit = FORBIDDEN.exec(withoutLiterals);
  if (hit) throw new Error(`Report query contains a forbidden keyword: ${hit[1]!.toLowerCase()}`);
}

export const READ_ONLY_SETUP = ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '30s'"] as const;

export function validateLeadNumber(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v && /^[A-Za-z0-9-]{1,50}$/.test(v) ? v : null;
}

// ---- Masking --------------------------------------------------------------------------------------------------------------------------
/** A short stable fingerprint so two rows can be seen to share (or not share) a cart reference without printing it. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** "abcd1234wxyz" -> "ab…yz (len 12, fp 1a2b3c4d)". Cart references are tokens; only 2+2 characters and a fingerprint are shown. */
export function maskReference(ref: string | null): string {
  if (ref === null) return "(null)";
  if (ref === "") return "(empty)";
  const chars = [...ref];
  const edge = chars.length > 8 ? `${chars.slice(0, 2).join("")}…${chars.slice(-2).join("")}` : "…";
  return `${edge} (len ${chars.length}, fp ${fingerprint(ref)})`;
}

// ---- Rows & grouping ------------------------------------------------------------------------------------------------------------------
export interface RawRow {
  id: string; lead_id: string; lead_number: string; type: string; status: string;
  reference_type: string | null; reference_id: string | null; stage: string | null; cart_value: string | null;
  detected_at: Date; created_at: Date; updated_at: Date; recovered_at: Date | null;
  activity_count: string | number; recovery_action_count: string | number;
}

export interface RecordView {
  id: string; leadId: string; leadNumber: string; status: string; reference: string; referenceFp: string | null; stage: string | null;
  cartValue: string | null; detectedAt: string; createdAt: string; updatedAt: string; recoveredAt: string | null;
  activities: number; recoveryActions: number;
}

export const OPEN = new Set(["ACTIVE", "IN_PROGRESS"]);

export function toView(r: RawRow): RecordView {
  return {
    id: r.id, leadId: r.lead_id, leadNumber: r.lead_number, status: r.status,
    reference: maskReference(r.reference_id), referenceFp: r.reference_id === null ? null : fingerprint(r.reference_id),
    stage: r.stage, cartValue: r.cart_value,
    detectedAt: r.detected_at.toISOString(), createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    recoveredAt: r.recovered_at ? r.recovered_at.toISOString() : null,
    activities: Number(r.activity_count), recoveryActions: Number(r.recovery_action_count),
  };
}

export type Pattern =
  | "SAME_REFERENCE_AND_STAGE"   // identical (reference, stage): the ingest code should have merged these
  | "SAME_REFERENCE_DIFF_STAGE"  // one cart reference, different stage values
  | "NULL_REFERENCE"             // no cart reference on the rows
  | "DIFFERENT_REFERENCES";      // several non-null references under one lead

export interface Group {
  leadId: string; leadNumber: string;
  referenceFp: string | null; reference: string; stage: string | null;
  count: number; recordIds: string[]; statuses: string[];
  firstCreatedAt: string; lastCreatedAt: string; createdSpanMs: number;
  activitiesPerRecord: number[];
}

/** Open records grouped by (lead, reference, stage). Groups of size 1 are kept (the caller decides what to show). Never merges across leads. */
export function groupOpen(rows: RawRow[]): Group[] {
  const map = new Map<string, RawRow[]>();
  for (const r of rows) {
    if (!OPEN.has(r.status)) continue;
    const key = JSON.stringify([r.lead_id, r.reference_id, r.stage]);
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  return [...map.values()].map((g) => {
    const sorted = [...g].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
    const first = sorted[0]!, last = sorted[sorted.length - 1]!;
    return {
      leadId: first.lead_id, leadNumber: first.lead_number,
      referenceFp: first.reference_id === null ? null : fingerprint(first.reference_id), reference: maskReference(first.reference_id), stage: first.stage,
      count: sorted.length, recordIds: sorted.map((r) => r.id), statuses: sorted.map((r) => r.status),
      firstCreatedAt: first.created_at.toISOString(), lastCreatedAt: last.created_at.toISOString(),
      createdSpanMs: last.created_at.getTime() - first.created_at.getTime(),
      activitiesPerRecord: sorted.map((r) => Number(r.activity_count)),
    };
  }).sort((a, b) => a.leadNumber.localeCompare(b.leadNumber) || a.firstCreatedAt.localeCompare(b.firstCreatedAt));
}

/** The repeated (count > 1) groups only. */
export const repeatedGroups = (groups: Group[]): Group[] => groups.filter((g) => g.count > 1);

/** What the OPEN rows of ONE lead look like, as a set of facts - not a verdict. */
export function patternsForLead(openRows: RawRow[]): Pattern[] {
  const out = new Set<Pattern>();
  if (openRows.length < 2) return [];
  const byRef = new Map<string | null, RawRow[]>();
  for (const r of openRows) byRef.set(r.reference_id, [...(byRef.get(r.reference_id) ?? []), r]);
  for (const [ref, rs] of byRef) {
    if (rs.length < 2) continue;
    if (ref === null) out.add("NULL_REFERENCE");
    const stages = new Set(rs.map((r) => r.stage));
    out.add(stages.size === 1 ? "SAME_REFERENCE_AND_STAGE" : "SAME_REFERENCE_DIFF_STAGE");
  }
  if ([...byRef.keys()].filter((k) => k !== null).length > 1) out.add("DIFFERENT_REFERENCES");
  return [...out];
}

/** Plain-language reading of each pattern. Every line states what is NOT established. */
export const PATTERN_NOTES: Record<Pattern, string> = {
  SAME_REFERENCE_AND_STAGE:
    "Several open rows share the same cart reference and stage. Current ingest code is meant to refresh one row per cart, so this is unexpected going forward. It is consistent with a concurrent-delivery race OR with rows written before the dedupe/lock existed; the data alone does not say which.",
  SAME_REFERENCE_DIFF_STAGE:
    "Same cart reference but different stage values. Ingest does not key on stage, so it would normally refresh one row; the stage value is simply whatever the last delivery carried. Why several rows exist is not established.",
  NULL_REFERENCE:
    "Rows with no cart reference. Ingest merges repeats only among a lead's null-reference rows, so several here means they predate that rule, raced, or the payload carried no usable id. Whether they describe one real cart cannot be told from this report.",
  DIFFERENT_REFERENCES:
    "Several distinct non-null cart references. These may be genuinely different carts (legitimate) or one cart whose id changed between deliveries; this report cannot distinguish them. Do not treat them as duplicates without further evidence.",
};

/** Timing is context only: rows created close together are COMPATIBLE with concurrent processing but do not prove it, and rows created far apart do not rule out a bug. */
export function timingNote(spanMs: number): string {
  if (spanMs < 5_000) return `created within ${spanMs} ms of each other (compatible with concurrent processing; not proof)`;
  if (spanMs < 3_600_000) return `created ${Math.round(spanMs / 1000)} s apart (sequential deliveries are at least as plausible as a race)`;
  return `created ${(spanMs / 3_600_000).toFixed(1)} h apart (not consistent with a same-moment race; look at retries / reference changes)`;
}

export interface LeadSummary {
  leadNumber: string; leadId: string;
  totalCheckoutRecords: number; openRecords: number;
  patterns: Pattern[];
  repeatedGroups: Group[];
}

export function summarizeLead(rows: RawRow[]): LeadSummary | null {
  if (rows.length === 0) return null;
  const open = rows.filter((r) => OPEN.has(r.status));
  return {
    leadNumber: rows[0]!.lead_number, leadId: rows[0]!.lead_id,
    totalCheckoutRecords: rows.length, openRecords: open.length,
    patterns: patternsForLead(open), repeatedGroups: repeatedGroups(groupOpen(rows)),
  };
}

export function summarizeBroad(rows: RawRow[]): LeadSummary[] {
  const byLead = new Map<string, RawRow[]>();
  for (const r of rows) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r]);
  return [...byLead.values()].map((g) => summarizeLead(g)!).sort((a, b) => a.leadNumber.localeCompare(b.leadNumber));
}
