import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { myFollowUpsQueryOptions } from "@/lib/api-client/queries/tasks.queries";
import type { FollowUpTask } from "@/lib/api-client/types/tasks.types";
import { MIN_GAP_MS, toLocalInputValue } from "./follow-up-utils";

/**
 * Whether another lead's reminder is closer than MIN_GAP_MS to the chosen time. Checked against the
 * reminders the bell already loads (the next 36 hours), so it warns instantly; the backend still
 * rejects a clash outside that window, or one made from another tab, with a clear message.
 * `leadId` is the lead being scheduled - its own existing reminder is about to be replaced, so it
 * never counts as a clash.
 */
export function useFollowUpConflict(leadId: string | undefined, value: string) {
  const { data: followUps = [] } = useQuery(myFollowUpsQueryOptions());

  return useMemo((): { conflict?: FollowUpTask; nextFree?: string } => {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return {};

    const others = followUps
      .filter((task) => task.lead.id !== leadId)
      .map((task) => ({ task, at: new Date(task.scheduledAt).getTime() }));
    const clashAt = (t: number) => others.filter((o) => Math.abs(o.at - t) < MIN_GAP_MS);

    const clashing = clashAt(ms);
    if (clashing.length === 0) return {};

    // The closest one is named in the warning; then hop past whatever blocks until a time is free.
    const conflict = clashing.reduce((a, b) => (Math.abs(a.at - ms) <= Math.abs(b.at - ms) ? a : b)).task;
    let next = ms;
    for (let i = 0; i < 100; i++) {
      const blockers = clashAt(next);
      if (blockers.length === 0) break;
      next = Math.max(...blockers.map((o) => o.at)) + MIN_GAP_MS;
    }
    return { conflict, nextFree: toLocalInputValue(new Date(next)) };
  }, [followUps, leadId, value]);
}
