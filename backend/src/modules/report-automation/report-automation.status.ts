import type { DbClient } from "@/lib/leadScope.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { recomputeRunStatus } from "./report-automation.run.js";

// PROVIDER DELIVERY CALLBACKS for report messages. The WhatsApp webhooks (Meta Cloud API and AiSensy) already verify their own signatures and de-duplicate deliveries before they reach
// WhatsAppService.recordStatusUpdate; that function calls this one, so a status update is only ever applied after the existing signature check. Matching is by the provider's message id
// (and the provider that accepted it), so an unrelated message can never change a report row.
//
// Rules (idempotent - applying the same event twice changes nothing):
//   - DELIVERED / READ come ONLY from these callbacks, never from the provider accepting the send request. Status only moves forward: SENT < DELIVERED < READ.
//   - A late or duplicate event never moves a status backwards; it may only fill in the time of its own milestone if that was never recorded.
//   - FAILED (the provider reports the message could not be delivered) replaces SENT / UNCERTAIN, with the provider's reason, but never overrides DELIVERED or READ.

export type ProviderStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";
export interface ProviderStatusEvent {
  providerMessageId: string;
  status: ProviderStatus;
  timestamp: Date;
  errorCode?: string;
  errorMessage?: string;
}

const RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };

type Part = { status: string; deliveredAt: Date | null; readAt: Date | null; sentAt: Date | null };

/** The update for ONE message (the text template message or the Excel document) of a recipient row; empty = nothing to change. Pure, so both parts share the same rules. */
function nextPartState(part: Part, event: ProviderStatusEvent): { status?: string; deliveredAt?: Date; readAt?: Date; sentAt?: Date; error: string | null | undefined; clearNext: boolean } | null {
  const rank = RANK[part.status] ?? 0;
  const out: { status?: string; deliveredAt?: Date; readAt?: Date; sentAt?: Date; error: string | null | undefined; clearNext: boolean } = { error: undefined, clearNext: false };
  if (event.status === "DELIVERED") {
    if (rank < 2) { out.status = "DELIVERED"; out.deliveredAt = event.timestamp; out.error = null; }
    else if (!part.deliveredAt) out.deliveredAt = event.timestamp;
  } else if (event.status === "READ") {
    if (rank < 3) { out.status = "READ"; out.readAt = event.timestamp; out.error = null; if (!part.deliveredAt) out.deliveredAt = event.timestamp; }
    else if (!part.readAt) out.readAt = event.timestamp;
  } else if (event.status === "FAILED") {
    if (rank <= 1 || part.status === "UNCERTAIN" || part.status === "SENDING") { out.status = "FAILED"; out.clearNext = true; out.error = (event.errorMessage ?? event.errorCode ?? "The provider reported that the message could not be delivered").slice(0, 500); }
  } else if (event.status === "SENT") {
    if (part.status === "UNCERTAIN" || part.status === "SENDING") { out.status = "SENT"; out.sentAt = part.sentAt ?? event.timestamp; out.error = null; }
  }
  return out.status || out.deliveredAt || out.readAt ? out : null;
}

export async function applyReportDeliveryStatus(db: DbClient, provider: string, event: ProviderStatusEvent): Promise<number> {
  if (!event.providerMessageId) return 0;
  const rows = await db.reportDeliveryRecipient.findMany({ where: { OR: [{ providerMessageId: event.providerMessageId }, { txtProviderMessageId: event.providerMessageId }, { docProviderMessageId: event.providerMessageId }] } });
  let changed = 0;
  const runs = new Set<string>();
  for (const row of rows) {
    const data: Prisma.ReportDeliveryRecipientUpdateInput = {};
    // the TEXT message (matched by its own id, and only for the provider that accepted it)
    if (row.providerMessageId === event.providerMessageId && !(row.provider && row.provider !== provider)) {
      const n = nextPartState({ status: row.status, deliveredAt: row.deliveredAt, readAt: row.readAt, sentAt: row.sentAt }, event);
      if (n) {
        if (n.status) data.status = n.status as never;
        if (n.deliveredAt) data.deliveredAt = n.deliveredAt;
        if (n.readAt) data.readAt = n.readAt;
        if (n.sentAt) data.sentAt = n.sentAt;
        if (n.error !== undefined) data.error = n.error;
        if (n.clearNext) data.nextAttemptAt = null;
      }
    }
    // the DETAILED TEXT (its own message id; always sent through Meta)
    if (row.txtProviderMessageId === event.providerMessageId && provider === "META") {
      const n = nextPartState({ status: row.txtStatus, deliveredAt: row.txtDeliveredAt, readAt: row.txtReadAt, sentAt: row.txtSentAt }, event);
      if (n) {
        if (n.status) data.txtStatus = n.status as never;
        if (n.deliveredAt) data.txtDeliveredAt = n.deliveredAt;
        if (n.readAt) data.txtReadAt = n.readAt;
        if (n.sentAt) data.txtSentAt = n.sentAt;
        if (n.error !== undefined) data.txtError = n.error;
      }
    }
    // the Excel DOCUMENT (its own message id; always sent through Meta)
    if (row.docProviderMessageId === event.providerMessageId && provider === "META") {
      const n = nextPartState({ status: row.docStatus, deliveredAt: row.docDeliveredAt, readAt: row.docReadAt, sentAt: row.docSentAt }, event);
      if (n) {
        if (n.status) data.docStatus = n.status as never;
        if (n.deliveredAt) data.docDeliveredAt = n.deliveredAt;
        if (n.readAt) data.docReadAt = n.readAt;
        if (n.sentAt) data.docSentAt = n.sentAt;
        if (n.error !== undefined) data.docError = n.error;
      }
    }
    if (Object.keys(data).length === 0) continue;
    await db.reportDeliveryRecipient.update({ where: { id: row.id }, data });
    runs.add(row.deliveryId);
    changed++;
  }
  for (const id of runs) await recomputeRunStatus(db, id);
  return changed;
}
