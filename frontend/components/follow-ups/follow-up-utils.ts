import type { FollowUpTask, FollowUpTaskType } from "@/lib/api-client/types/tasks.types";

export const FOLLOW_UP_TYPE_LABEL: Record<FollowUpTaskType, string> = {
  CALLBACK: "Call back",
  FOLLOW_UP: "Follow up",
};

/** Minimum gap between one person's reminders - keep in sync with MIN_GAP_MS in the backend's tasks.followup.ts. */
export const MIN_GAP_MS = 5 * 60_000;
/** How long before the scheduled time the heads-up toast fires. */
export const HEADS_UP_MS = 5 * 60_000;
/** A reminder older than this no longer pops up on its own; it stays in the bell list as overdue. */
export const DUE_POPUP_WINDOW_MS = 2 * 60 * 60_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** Date -> the "YYYY-MM-DDTHH:mm" local-time string a datetime-local input expects. */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value (local time) -> ISO string for the API, or undefined if empty/invalid. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function leadDisplayName(lead: FollowUpTask["lead"]): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ");
}

/** "Today, 4:30 PM" / "Tomorrow, 10:00 AM" / "Mon 28 Sep, 11:00 AM". */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Tomorrow, ${time}`;
  if (dayDiff === -1) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

/** "in 4 min" / "12 min ago" / "in 2 h". */
export function formatRelative(iso: string, now = Date.now()): string {
  const diffMin = Math.round((new Date(iso).getTime() - now) / 60_000);
  const abs = Math.abs(diffMin);
  const text = abs < 1 ? "now" : abs < 60 ? `${abs} min` : `${Math.round(abs / 60)} h`;
  if (text === "now") return "now";
  return diffMin > 0 ? `in ${text}` : `${text} ago`;
}
