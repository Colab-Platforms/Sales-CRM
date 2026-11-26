// Pure rules for the Orders list's order count and downloads (no React, no I/O), so they are testable on their own.
import type { LiveExportReply, LiveOrderCount } from "@/lib/api-client/types/orders.types";

/** The most orders one "Download selected" takes (the server enforces the same). */
export const MAX_SELECTED_ORDERS = 1000;
const POLL_MS = 1500;
const GIVE_UP_AFTER_MS = 15 * 60_000;

const n = (value: number) => value.toLocaleString("en-IN");

/** "3,200 of 9,455 orders checked" while the server reads a large set; "" before it has anything to report. */
export function progressText(checked: number, expected: number | null): string {
  if (expected !== null) return `${n(checked)} of ${n(expected)} orders checked`;
  return checked > 0 ? `${n(checked)} orders checked` : "";
}

/** The count line. A number is shown only when it belongs to the filters on screen - never a previous filter's. */
export function countText(state: { data: LiveOrderCount | null; failed: boolean; waiting: boolean }): string {
  if (state.failed) return "Order count unavailable.";
  if (!state.waiting && state.data?.status === "ready") return `${n(state.data.total)} matching ${state.data.total === 1 ? "order" : "orders"}`;
  const progress = !state.waiting && state.data?.status === "pending" ? progressText(state.data.checked, state.data.expected) : "";
  return progress ? `Counting orders… (${progress})` : "Counting orders…";
}

/** The list's current query as the export wants it: the same values the list and count send, as strings, without pagination. */
export function exportFilters(params: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "after" || key === "first" || value === undefined || value === "") continue;
    const text = Array.isArray(value) ? value.join(",") : String(value);
    if (text) out[key] = text;
  }
  return out;
}

/** Asks for the file until the server has it ready. Returns null if the caller stopped waiting (left the page). */
export async function waitForOrdersFile(
  request: () => Promise<LiveExportReply>,
  options: { onProgress?: (text: string) => void; cancelled?: () => boolean; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Extract<LiveExportReply, { status: "ready" }> | null> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const started = now();
  for (;;) {
    const reply = await request();
    if (options.cancelled?.()) return null;
    if (reply.status === "ready") return reply;
    options.onProgress?.(progressText(reply.checked, reply.expected));
    if (now() - started > GIVE_UP_AFTER_MS) throw new Error("Preparing the file is taking too long. Choose a shorter date range and try again.");
    await sleep(POLL_MS);
    if (options.cancelled?.()) return null;
  }
}

/** Ticked rows belong to one set of filters: under any other filters the selection is empty, so a hidden order is never downloaded by surprise. */
export interface Selection {
  filterKey: string;
  ids: ReadonlySet<string>;
}
export const NOTHING_SELECTED: ReadonlySet<string> = new Set();
export const selectedFor = (selection: Selection | null, filterKey: string): ReadonlySet<string> => (selection?.filterKey === filterKey ? selection.ids : NOTHING_SELECTED);

export function toggleSelected(current: ReadonlySet<string>, ids: string[], checked: boolean): Set<string> {
  const next = new Set(current);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}
