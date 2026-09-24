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

export async function matchSenderToLead(rawFrom: string, { db }: MatchDeps): Promise<MatchResult> {
  const normalizedContact = normalizeMobile(rawFrom);
  if (!normalizedContact) return { leadId: null, normalizedContact: null };

  const lead = await db.lead.findFirst({
    where: { normalizedMobile: normalizedContact },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return { leadId: lead?.id ?? null, normalizedContact };
}
