import { CallStatus } from "../../../generated/prisma/enums.js";

// ---------------------------------------------------------------------------------------------
// The call-outcome and lead-stage rules shared by every report metric. Calls, lead counts and
// orders all go through these, so a filter always means the same thing on every number it touches.
// ---------------------------------------------------------------------------------------------

export type CallStatusFilter = "ALL" | "CONNECTED" | "NOT_CONNECTED" | "FAILED";
export type LeadStatusFilter = "ALL" | "NOT_CONTACTED" | "CONTACTED" | "INTERESTED" | "CONVERTED";
export type CallKind = "connected" | "failed" | "notConnected";

const CONNECTED_STATUSES = new Set<CallStatus>([CallStatus.CONNECTED, CallStatus.COMPLETED, CallStatus.AGENT_ANSWERED]);

/** Connected = the customer was reached; Failed = the call failed; everything else is Not connected. */
export function classify(status: CallStatus): CallKind {
  if (CONNECTED_STATUSES.has(status)) return "connected";
  if (status === CallStatus.FAILED) return "failed";
  return "notConnected";
}

export function matchesCallStatus(kind: CallKind | null, filter: CallStatusFilter): boolean {
  if (filter === "ALL") return true;
  if (kind === null) return false;
  return (
    (filter === "CONNECTED" && kind === "connected") ||
    (filter === "NOT_CONNECTED" && kind === "notConnected") ||
    (filter === "FAILED" && kind === "failed")
  );
}

/**
 * Where a lead stands *for the salesperson who now owns it*. Only that person's own work after the lead was
 * assigned to them counts, so a lead that arrives already CONVERTED (e.g. a returning Shopify customer, or a lead
 * someone else worked before) is "not contacted" until its new owner actually does something with it.
 */
export interface LeadStageInput {
  /** The owner called it, acted on it, or it was marked contacted - after the assignment. */
  touched: boolean;
  /** The owner marked it interested after the assignment. */
  interested: boolean;
  /** The owner converted it (status change or a confirmed order) after the assignment. */
  converted: boolean;
}

export function leadStages(lead: LeadStageInput) {
  const converted = lead.converted;
  const interested = converted || lead.interested;
  const contacted = interested || lead.touched;
  return { contacted, interested, converted };
}

export function matchesLeadStatus(lead: LeadStageInput, filter: LeadStatusFilter): boolean {
  if (filter === "ALL") return true;
  const s = leadStages(lead);
  if (filter === "NOT_CONTACTED") return !s.contacted;
  if (filter === "CONTACTED") return s.contacted;
  if (filter === "INTERESTED") return s.interested;
  return s.converted;
}

// Activity titles the CRM writes when a salesperson moves a lead forward (see lead status / call outcome updates).
const INTERESTED_TITLES = new Set(["Status changed to INTERESTED", "Call outcome: Interested"]);
const CONVERTED_TITLES = new Set(["Status changed to CONVERTED", "Call outcome: Converted"]);

/** Builds a lead's stage for its owner from the owner's own records dated on or after `since` (the assignment). */
export function ownerProgress(input: {
  ownerId: string;
  since: Date;
  lastContactedAt: Date | null;
  calls: { agentId: string; startedAt: Date | null; createdAt: Date }[];
  activities: { actorId: string | null; type: string; title: string | null; createdAt: Date }[];
  interestedPeriods: { qualifiedById: string; startedAt: Date }[];
  orders: { confirmedByUserId: string | null; confirmedAt: Date | null }[];
}): LeadStageInput {
  const { ownerId, since } = input;
  const mine = input.activities.filter((a) => a.actorId === ownerId && a.createdAt >= since);
  const isStatus = (titles: Set<string>) => mine.some((a) => a.type === "STATUS_CHANGE" && a.title !== null && titles.has(a.title));
  const converted =
    isStatus(CONVERTED_TITLES) || input.orders.some((o) => o.confirmedByUserId === ownerId && o.confirmedAt !== null && o.confirmedAt >= since);
  const interested = isStatus(INTERESTED_TITLES) || input.interestedPeriods.some((p) => p.qualifiedById === ownerId && p.startedAt >= since);
  const touched =
    mine.length > 0 ||
    input.calls.some((c) => c.agentId === ownerId && (c.startedAt ?? c.createdAt) >= since) ||
    (input.lastContactedAt !== null && input.lastContactedAt >= since);
  return { touched, interested, converted };
}

/**
 * The call that led to an order: the confirming telecaller's latest call to the order's lead at or
 * before the moment the order was confirmed. Null when they never called that lead before confirming
 * (e.g. an order taken over WhatsApp only).
 */
export function closingCall<C extends { leadId: string | null; agentId: string; status: CallStatus; startedAt: Date | null; createdAt: Date }>(
  calls: C[],
  order: { leadId: string; confirmedByUserId: string; confirmedAt: Date },
): C | null {
  let best: C | null = null;
  for (const c of calls) {
    if (c.leadId !== order.leadId || c.agentId !== order.confirmedByUserId) continue;
    const at = c.startedAt ?? c.createdAt;
    if (at > order.confirmedAt) continue;
    if (!best || at > (best.startedAt ?? best.createdAt)) best = c;
  }
  return best;
}
