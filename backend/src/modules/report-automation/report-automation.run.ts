import type { DbClient } from "@/lib/leadScope.js";

// A report RUN (ReportDelivery) is the day's report; each recipient has its own result row (ReportDeliveryRecipient). The run's own status is only a SUMMARY of its recipients' results, recomputed here:
//   SENDING   someone is mid-send          PENDING  someone is still to be tried
//   FAILED    at least one definite failure (the others may have succeeded - see the per-recipient rows)
//   UNCERTAIN at least one outcome unknown, none failed
//   SENT      everyone's message was accepted (or better: delivered / read)
export async function recomputeRunStatus(db: DbClient, runId: string): Promise<void> {
  const rows = await db.reportDeliveryRecipient.findMany({ where: { deliveryId: runId } });
  if (rows.length === 0) return;
  if ((await db.reportDelivery.findUnique({ where: { id: runId }, select: { status: true } }))?.status === "CANCELLED") return; // a cancelled occurrence stays cancelled
  // Both parts count: the text message and the Excel document. A SKIPPED part (switched off) is ignored. The run is SENT only when every part that is on has been accepted.
  const text = rows.map((r) => r.status).filter((s) => s !== "SKIPPED");
  const docs = rows.map((r) => r.docStatus).filter((s) => s !== "SKIPPED");
  const txts = rows.map((r) => r.txtStatus).filter((s) => s !== "SKIPPED");
  const all = [...text, ...txts, ...docs];
  const has = (s: string) => all.includes(s as never);
  const status = has("SENDING") ? "SENDING" : text.includes("PENDING" as never) ? "PENDING" : has("FAILED") ? "FAILED" : has("UNCERTAIN") ? "UNCERTAIN" : [...txts, ...docs].some((s) => s === "PENDING" || s === "WAITING_FOR_REPLY") ? "PENDING" : "SENT" // a part waiting for the recipient's reply keeps the run open (not Sent, not Failed);
  const bad = (st: string) => st === "FAILED" || st === "UNCERTAIN";
  const failing = rows.find((r) => bad(r.status) || bad(r.txtStatus) || bad(r.docStatus));
  const failingError = failing ? (bad(failing.status) ? failing.error : bad(failing.txtStatus) ? failing.txtError : failing.docError) : null;
  const sentTimes = rows.map((r) => r.sentAt?.getTime()).filter((t): t is number => typeof t === "number");
  const retryTimes = rows.filter((r) => r.status === "FAILED" && r.nextAttemptAt).map((r) => r.nextAttemptAt!.getTime());
  await db.reportDelivery.update({
    where: { id: runId },
    data: {
      status,
      attempts: Math.max(...rows.map((r) => Math.max(r.attempts, r.txtAttempts, r.docAttempts))),
      error: failingError ?? null,
      providerMessageId: rows.find((r) => r.providerMessageId)?.providerMessageId ?? null,
      sentAt: sentTimes.length > 0 ? new Date(Math.min(...sentTimes)) : null,
      nextAttemptAt: retryTimes.length > 0 ? new Date(Math.min(...retryTimes)) : null,
    },
  });
}
