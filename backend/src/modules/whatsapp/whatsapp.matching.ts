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
  db: Pick<Prisma.TransactionClient, "lead">;
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
// Exported so other inbound-identity-matching code (webhooks/callerdesk, webhooks/website-chat) can
// reuse the exact same legacy-shape tolerance rather than inventing a second, competing one - this
// function's job (and the bug it fixes) is CRM-wide, not WhatsApp-specific.
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

export async function matchSenderToLead(rawFrom: string, { db }: MatchDeps): Promise<MatchResult> {
  const normalizedContact = normalizeMobile(rawFrom);
  if (!normalizedContact) return { leadId: null, normalizedContact: null };

  const lead = await db.lead.findFirst({
    where: { normalizedMobile: { in: legacyMatchCandidates(normalizedContact) } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return { leadId: lead?.id ?? null, normalizedContact };
}
