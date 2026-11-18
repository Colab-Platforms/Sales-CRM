import type { ReportRecipientResult } from "@/lib/api-client/types/report-automation.types";

// How a recipient's stored WhatsApp state is shown. Pure: no network, no clock. Everything here is derived from fields the server only fills from the provider's own callbacks (SENT -> DELIVERED -> READ,
// FAILED) and from real inbound messages (repliedAt). Nothing is inferred: a part that was only accepted is never shown as delivered, and a recipient who read the message is not "replied".

export type Tick = "PENDING" | "WAITING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "UNKNOWN";
const RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };

export const TICK_LABEL: Record<Tick, string> = { PENDING: "Pending", WAITING: "Waiting for reply", SENT: "Sent", DELIVERED: "Delivered", READ: "Read", FAILED: "Failed", UNKNOWN: "Outcome unknown" };

/** The tick of ONE message from its stored status. */
export function partTick(status: string): Tick {
  if (status === "READ" || status === "DELIVERED" || status === "SENT" || status === "FAILED") return status;
  if (status === "UNCERTAIN") return "UNKNOWN";
  if (status === "WAITING_FOR_REPLY") return "WAITING";
  return "PENDING";
}

/** The three WhatsApp messages of a recipient (summary template, detailed text, Excel) that are switched on, with their own states. */
export function partsOf(r: ReportRecipientResult) {
  return [
    { key: "summary", label: "WhatsApp summary", status: r.status as string, error: r.error, sentAt: r.sentAt, deliveredAt: r.deliveredAt, readAt: r.readAt, lastAttemptAt: r.lastAttemptAt, attempts: r.attempts },
    { key: "detail", label: "Detailed report", status: r.detail.status as string, error: r.detail.error, sentAt: r.detail.sentAt, deliveredAt: r.detail.deliveredAt, readAt: r.detail.readAt, lastAttemptAt: r.detail.lastAttemptAt, attempts: r.detail.attempts },
    { key: "excel", label: "Excel", status: r.document.status as string, error: r.document.error, sentAt: r.document.sentAt, deliveredAt: r.document.deliveredAt, readAt: r.document.readAt, lastAttemptAt: r.document.lastAttemptAt, attempts: r.document.attempts },
  ].filter((p) => p.status !== "SKIPPED");
}

export interface MessageState { tick: Tick; label: string; /** The furthest message reached a tick but another message of this recipient definitely failed. */ partialFailure: boolean; hasFailure: boolean; updatedAt: string | null }

/** The recipient's overall message status: the furthest tick any of their messages reached (read > delivered > sent). With no accepted message: failed, unknown outcome, waiting for their reply, or pending. */
export function messageState(r: ReportRecipientResult): MessageState {
  const parts = partsOf(r);
  const best = Math.max(0, ...parts.map((p) => RANK[p.status] ?? 0));
  const hasFailure = parts.some((p) => p.status === "FAILED");
  let tick: Tick;
  if (best >= 3) tick = "READ";
  else if (best === 2) tick = "DELIVERED";
  else if (best === 1) tick = "SENT";
  else if (hasFailure) tick = "FAILED";
  else if (parts.some((p) => p.status === "UNCERTAIN")) tick = "UNKNOWN";
  else if (parts.some((p) => p.status === "WAITING_FOR_REPLY")) tick = "WAITING";
  else tick = "PENDING";
  const times = [...parts.flatMap((p) => [p.sentAt, p.deliveredAt, p.readAt, p.lastAttemptAt]), r.repliedAt].filter((t): t is string => Boolean(t));
  const updatedAt = times.length > 0 ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
  return { tick, label: TICK_LABEL[tick], partialFailure: best > 0 && hasFailure, hasFailure, updatedAt };
}

export interface TrackingCounts { total: number; sent: number; delivered: number; read: number; replied: number; failed: number }

/**
 * The run's cards. Sent / Delivered / Read are cumulative, like WhatsApp's own ticks: a message that was read was also delivered and sent. Replied counts recipients with a recorded inbound reply. Failed counts
 * recipients with at least one message the provider or the CRM definitely failed to send.
 */
export function trackingCounts(recipients: ReportRecipientResult[]): TrackingCounts {
  const states = recipients.map((r) => messageState(r));
  const at = (min: number) => states.filter((s) => (RANK[s.tick] ?? 0) >= min).length;
  return { total: recipients.length, sent: at(1), delivered: at(2), read: at(3), replied: recipients.filter((r) => Boolean(r.repliedAt)).length, failed: states.filter((s) => s.hasFailure).length };
}

/** "9:15 AM" for today, "17 Nov, 9:15 AM" for another day - in the report's timezone. */
export function shortTime(iso: string | null, timezone: string, now: Date = new Date()): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  if (day(d) === day(now)) return time;
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short" }).format(d)}, ${time}`;
}
