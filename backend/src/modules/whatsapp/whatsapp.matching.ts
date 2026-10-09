import { normalizeMobile } from "@/lib/leadIdentity.js";
import type { Prisma } from "../../../generated/prisma/client.js";

// Resolves an inbound WhatsApp sender to an existing lead by phone number only - the one identity
// signal a WhatsApp message actually carries. Uses the same normalizeMobile the rest of the CRM
// (imports, calls, order booking) already agrees on, so a match here means the same phone number
// would also match during a Shopify import or a manual lead lookup.
//
// Never creates a lead. An unmatched sender's message is still stored (leadId left null); it is
// simply not attached to anyone, exactly as E7.1 Phase 6 requires.

export interface MatchDeps {
  // whatsAppMessage is optional only so callers/tests that never need thread-affinity can pass just `lead`; the webhook always passes the full client.
  db: Pick<Prisma.TransactionClient, "lead"> & Partial<Pick<Prisma.TransactionClient, "whatsAppMessage">>;
}

export interface MatchResult {
  leadId: string | null;
  normalizedContact: string | null;
}

// Bug fix: a real, non-trivial number of leads (created before Lead.normalizedMobile consistently
// went through normalizeMobile, or written by a path that bypassed it) have their normalizedMobile
// stored in a legacy shape this function never produces - confirmed against production data in two
// distinct forms: with the leading "+" dropped but the country code kept (e.g. "917840956315"
// instead of "+917840956315"), AND with the country code dropped entirely, down to a bare 10-digit
// local number (e.g. "9676725103" instead of "+919676725103" - actually the MORE common of the two
// shapes in this database). An exact-match lookup against only the canonical form silently missed
// both - the inbound reply looked unmatched, a brand-new duplicate lead got auto-created for it, and
// the reply landed in a separate Inbox conversation instead of the customer's real, existing one.
// Matching against every plausible legacy shape makes this resilient regardless of which one a given
// lead happens to have, without requiring every existing lead to be individually repaired first.
export function legacyMatchCandidates(normalized: string): string[] {
  const candidates = new Set<string>([normalized, normalized.replace(/^\+/, "")]);
  // India-specific extra legacy shapes - this CRM's only default country (see normalizeMobile's own
  // comment: "The store is Indian (INR)"). A stored value that dropped the country code entirely,
  // with or without the local trunk "0" some legacy imports retained.
  const india = /^\+91(\d{10})$/.exec(normalized);
  if (india) {
    candidates.add(india[1]!);
    candidates.add(`0${india[1]}`);
  }
  return [...candidates];
}

/**
 * The leads that are the SAME customer for messaging purposes: every lead whose phone is this lead's phone in any stored shape (+91..., 91..., bare 10 digits). Always includes the lead
 * itself. Exact-phone only - two people are never merged on a name or a partial number. Used to show ONE Inbox conversation per phone and to read its whole thread.
 */
export async function siblingLeadIds(db: Pick<Prisma.TransactionClient, "lead">, leadId: string): Promise<string[]> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { normalizedMobile: true, mobile: true } });
  const normalized = normalizeMobile(lead?.normalizedMobile ?? lead?.mobile ?? "");
  if (!normalized) return [leadId];
  const rows = await db.lead.findMany({ where: { normalizedMobile: { in: legacyMatchCandidates(normalized) } }, select: { id: true } });
  return [...new Set([leadId, ...rows.map((r) => r.id)])];
}

/** The thread of a customer: every lead with this phone, plus the phone shapes under which lead-less messages for it may be stored. */
export async function threadOf(db: Pick<Prisma.TransactionClient, "lead">, leadId: string): Promise<{ leadIds: string[]; contacts: string[] }> {
  const leadIds = await siblingLeadIds(db, leadId);
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { normalizedMobile: true, mobile: true } });
  const normalized = normalizeMobile(lead?.normalizedMobile ?? lead?.mobile ?? "");
  return { leadIds, contacts: normalized ? legacyMatchCandidates(normalized) : [] };
}

export async function matchSenderToLead(rawFrom: string, { db }: MatchDeps): Promise<MatchResult> {
  const normalizedContact = normalizeMobile(rawFrom);
  if (!normalizedContact) return { leadId: null, normalizedContact: null };

  const candidates = legacyMatchCandidates(normalizedContact);

  // Thread affinity. The same phone number can legitimately sit on more than one lead (a duplicate created by an import, a webhook or a manual entry). A reply must land in the
  // conversation the CRM was last talking to this customer in - the lead the template / message was SENT from - not simply the oldest lead with that number, or the customer's
  // answer lands on a different lead (often one outside the sender's team) and "disappears" from the Inbox thread that sent the template. The outbound row's contact may be stored
  // in any legacy shape, so it is looked up with the same candidate list.
  if (db.whatsAppMessage) {
    const lastSent = await db.whatsAppMessage.findFirst({
      where: { direction: "OUTBOUND", leadId: { not: null }, normalizedContact: { in: candidates }, lead: { normalizedMobile: { in: candidates } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { leadId: true },
    });
    if (lastSent?.leadId) return { leadId: lastSent.leadId, normalizedContact };
  }

  const lead = await db.lead.findFirst({
    where: { normalizedMobile: { in: candidates } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return { leadId: lead?.id ?? null, normalizedContact };
}
