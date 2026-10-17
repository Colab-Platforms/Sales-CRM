// Pure logic for the duplicate-lead merge DRY-RUN. No I/O, no database access: it only turns evidence that
// was READ elsewhere into a comparison and a description of what a human-approved merge would have to do.
// Nothing in here (or in duplicate-lead-merge-dryrun.ts) can execute a merge - the plan is printed as prose.
import { maskPhone } from "./duplicate-leads-report.safety.js";

/** Every column that references leads.id, derived from backend/prisma/schema/*.prisma (14 foreign keys).
 *  `unique` marks where re-pointing both leads onto one can violate a uniqueness rule and so needs a
 *  human decision. */
export interface LeadReference {
  table: string;
  column: string;
  nullable: boolean;
  unique?: { kind: "one-per-lead" } | { kind: "composite"; with: string };
}

export const LEAD_REFERENCES: readonly LeadReference[] = [
  { table: "calls", column: "lead_id", nullable: false },
  { table: "activities", column: "lead_id", nullable: true },
  { table: "tasks", column: "lead_id", nullable: false },
  { table: "orders", column: "lead_id", nullable: false },
  { table: "abandonments", column: "lead_id", nullable: false },
  { table: "recovery_actions", column: "lead_id", nullable: false },
  { table: "interested_lead_periods", column: "lead_id", nullable: false },
  { table: "lead_assignments", column: "lead_id", nullable: false },
  { table: "communication_preferences", column: "lead_id", nullable: false, unique: { kind: "composite", with: "channel" } },
  { table: "whatsapp_messages", column: "lead_id", nullable: true },
  { table: "whatsapp_automation_runs", column: "lead_id", nullable: true },
  { table: "whatsapp_campaign_recipients", column: "lead_id", nullable: false, unique: { kind: "composite", with: "campaign_id" } },
  { table: "whatsapp_conversations", column: "lead_id", nullable: false, unique: { kind: "one-per-lead" } },
  { table: "web_chat_conversations", column: "lead_id", nullable: true },
];

/** Not foreign keys, so the database would never complain - but they still point at a lead and would be
 *  left dangling by a merge unless handled. Counted and reported; never assumed to be zero. */
export const SOFT_REFERENCES = [
  "activities.reference_id where reference_type = 'Lead'",
  "webhook_events.payload (raw payloads keep the customer's phone/email, not our lead id - nothing to re-point)",
] as const;

export interface LeadEvidence {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  normalizedMobile: string | null;
  normalizedEmail: string | null;
  source: string | null;
  owner: { name: string; status: string } | null;
  assignedManager: string | null;
  group: string | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  lastContactedAt: Date | null;
  workingStatus: string;
  lifecycleStage: string;
  externalSource: string | null;
  externalId: string | null;
  /** rows per LEAD_REFERENCES entry, keyed `${table}.${column}` */
  counts: Record<string, number>;
  softReferenceCount: number;
  latestCallAt: Date | null;
  latestActivityAt: Date | null;
}

export interface Overlaps {
  /** channels for which BOTH leads have a communication_preferences row */
  communicationChannels: string[];
  /** campaigns in which BOTH leads are recipients */
  campaignIds: string[];
}

export const refKey = (r: LeadReference) => `${r.table}.${r.column}`;

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
}

export const totalLinked = (lead: LeadEvidence) => LEAD_REFERENCES.reduce((sum, r) => sum + (lead.counts[refKey(r)] ?? 0), 0);

const fullName = (l: LeadEvidence) => `${l.firstName} ${l.lastName ?? ""}`.trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface Repoint {
  table: string;
  column: string;
  rows: number;
  note?: string;
}
export interface MergeOption {
  survivor: string;
  retired: string;
  repoints: Repoint[];
  blockers: string[];
}
export interface MergePlan {
  warnings: string[];
  /** Factual points per lead. Deliberately NOT a verdict - the choice of survivor is a human decision. */
  evidence: Record<string, string[]>;
  options: MergeOption[];
}

function evidenceFor(lead: LeadEvidence, other: LeadEvidence): string[] {
  const out: string[] = [];
  const n = (k: string, l: LeadEvidence) => l.counts[k] ?? 0;
  if (n("calls.lead_id", lead) > n("calls.lead_id", other)) out.push(`more calls (${n("calls.lead_id", lead)} vs ${n("calls.lead_id", other)})`);
  if (n("orders.lead_id", lead) > 0) out.push(`has ${n("orders.lead_id", lead)} order(s)`);
  if (n("whatsapp_messages.lead_id", lead) > 0) out.push(`has ${n("whatsapp_messages.lead_id", lead)} WhatsApp message(s)`);
  if (lead.owner?.status === "ACTIVE" && other.owner?.status !== "ACTIVE") out.push("owner is an active user (the other lead's is not)");
  if (lead.source && !other.source) out.push("has a source recorded");
  if (lead.externalId && !other.externalId) out.push("linked to an external customer id");
  if (lead.latestCallAt && (!other.latestCallAt || lead.latestCallAt > other.latestCallAt)) out.push("most recent call");
  if (lead.latestActivityAt && (!other.latestActivityAt || lead.latestActivityAt > other.latestActivityAt)) out.push("most recent activity");
  if (lead.createdAt < other.createdAt) out.push("created first");
  return out;
}

export function buildMergePlan(a: LeadEvidence, b: LeadEvidence, overlaps: Overlaps): MergePlan {
  const warnings: string[] = [];

  if (a.normalizedMobile && b.normalizedMobile && a.normalizedMobile.replace(/\D/g, "").slice(-10) !== b.normalizedMobile.replace(/\D/g, "").slice(-10)) {
    warnings.push("The two leads' phone numbers differ - they are not the same-number duplicates this plan assumes.");
  }
  if (norm(a.firstName) !== norm(b.firstName) && norm(a.lastName ?? "") !== norm(b.lastName ?? "")) {
    warnings.push(`Names differ ("${fullName(a)}" vs "${fullName(b)}"). A shared phone number does not prove the same person - verify before merging.`);
  }
  if (a.owner && b.owner && a.owner.name !== b.owner.name) {
    warnings.push(`Different owners ("${a.owner.name}" vs "${b.owner.name}"): a merge leaves one salesperson without the lead and its call history.`);
  }
  if (a.externalId && b.externalId && (a.externalSource !== b.externalSource || a.externalId !== b.externalId)) {
    warnings.push("Both leads are linked to different external customer ids - merging would conflate two external customers.");
  }
  if (a.softReferenceCount + b.softReferenceCount > 0) {
    warnings.push(`${a.softReferenceCount + b.softReferenceCount} activity row(s) refer to a lead by reference_id rather than a foreign key; they need re-pointing too.`);
  }

  const option = (survivor: LeadEvidence, retired: LeadEvidence): MergeOption => {
    const repoints: Repoint[] = [];
    const blockers: string[] = [];
    for (const ref of LEAD_REFERENCES) {
      const rows = retired.counts[refKey(ref)] ?? 0;
      if (rows === 0) continue;
      repoints.push({ table: ref.table, column: ref.column, rows });
      if (ref.unique?.kind === "one-per-lead" && (survivor.counts[refKey(ref)] ?? 0) > 0) {
        blockers.push(`${ref.table}: each lead may have only one row and BOTH already do - one must be merged by hand, not re-pointed.`);
      }
      if (ref.table === "communication_preferences" && overlaps.communicationChannels.length) {
        blockers.push(`communication_preferences: both leads have a row for channel(s) ${overlaps.communicationChannels.join(", ")} - the conflicting rows must be resolved first.`);
      }
      if (ref.table === "whatsapp_campaign_recipients" && overlaps.campaignIds.length) {
        blockers.push(`whatsapp_campaign_recipients: both leads are recipients of ${overlaps.campaignIds.length} campaign(s) - the duplicate rows must be resolved first.`);
      }
    }
    if (retired.softReferenceCount > 0) {
      repoints.push({ table: "activities", column: "reference_id", rows: retired.softReferenceCount, note: "reference_type = 'Lead'" });
    }
    return { survivor: survivor.leadNumber, retired: retired.leadNumber, repoints, blockers };
  };

  return {
    warnings,
    evidence: { [a.leadNumber]: evidenceFor(a, b), [b.leadNumber]: evidenceFor(b, a) },
    options: [option(a, b), option(b, a)],
  };
}

/** Refuses anything that is not one plain SELECT. Every query the dry-run issues passes through this
 *  before it is sent, so even a coding mistake cannot turn into a write. */
export function assertSelectOnly(sql: string): void {
  const text = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(text)) throw new Error("dry-run refused a non-SELECT statement");
  if (text.includes(";")) throw new Error("dry-run refused a multi-statement query");
  const withoutLiterals = text.replace(/'[^']*'/g, "''");
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|copy|call|do|vacuum|lock)\b/i.test(withoutLiterals)) {
    throw new Error("dry-run refused a statement containing a write keyword");
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : "-");

export function formatPlan(a: LeadEvidence, b: LeadEvidence, plan: MergePlan): string[] {
  const lines: string[] = [];
  lines.push("DRY RUN - nothing was changed and nothing will be. This describes what a human-approved merge would involve.");
  lines.push("");
  lines.push("== Candidates (phone/email masked)");
  const row = (label: string, f: (l: LeadEvidence) => string) => lines.push(`${label.padEnd(30)} ${f(a).padEnd(40)} ${f(b)}`);
  row("lead number", (l) => l.leadNumber);
  row("id", (l) => l.id);
  row("name", fullName);
  row("phone", (l) => (l.normalizedMobile ? maskPhone(l.normalizedMobile) : "-"));
  row("email", (l) => maskEmail(l.normalizedEmail) ?? "-");
  row("owner", (l) => (l.owner ? `${l.owner.name} (${l.owner.status})` : "-"));
  row("assigned manager", (l) => l.assignedManager ?? "-");
  row("group", (l) => l.group ?? "-");
  row("source", (l) => l.source ?? "-");
  row("working status", (l) => l.workingStatus);
  row("lifecycle stage", (l) => l.lifecycleStage);
  row("external id", (l) => (l.externalId ? `${l.externalSource}:${l.externalId}` : "-"));
  row("created", (l) => iso(l.createdAt));
  row("last activity", (l) => iso(l.lastActivityAt));
  row("last contacted", (l) => iso(l.lastContactedAt));
  row("latest call", (l) => iso(l.latestCallAt));
  lines.push("");
  lines.push("== Linked records (every table with a foreign key to leads)");
  for (const ref of LEAD_REFERENCES) row(ref.table, (l) => String(l.counts[refKey(ref)] ?? 0));
  row("TOTAL", (l) => String(totalLinked(l)));
  row("soft refs (activities)", (l) => String(l.softReferenceCount));
  lines.push("");
  lines.push("== Warnings");
  if (plan.warnings.length === 0) lines.push("(none)");
  for (const w of plan.warnings) lines.push(`! ${w}`);
  lines.push("");
  lines.push("== Evidence per lead (facts only - NOT a recommendation; the survivor is a human decision)");
  for (const l of [a, b]) lines.push(`${l.leadNumber}: ${plan.evidence[l.leadNumber]!.join("; ") || "no distinguishing evidence"}`);
  lines.push("");
  lines.push("== If a human approves: one transaction, backup taken first");
  for (const o of plan.options) {
    lines.push(`-- Option: keep ${o.survivor}, retire ${o.retired}`);
    if (o.repoints.length === 0) lines.push("   (nothing to re-point)");
    for (const r of o.repoints) lines.push(`   re-point ${r.table}.${r.column}: ${r.rows} row(s) -> ${o.survivor}${r.note ? ` [${r.note}]` : ""}`);
    for (const blocker of o.blockers) lines.push(`   BLOCKER: ${blocker}`);
    lines.push(`   then: keep ${o.survivor}'s own fields unless a human copies over missing ones; mark ${o.retired} retired (not deleted) once the counts above reconcile.`);
  }
  lines.push("");
  lines.push(`Not covered by foreign keys: ${SOFT_REFERENCES.join("; ")}.`);
  return lines;
}
