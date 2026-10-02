import type { CallStatus } from "@/lib/api-client/types/calls.types";
import type { CallStatusCount } from "@/lib/api-client/types/call-history.types";

/**
 * Groups the real `CallStatus` values into the summary-card buckets the IVR pages show. No bucket
 * here is invented: every grouping is just a sum of real statuses the backend reports.
 *
 * "Missed" and "Abandoned" are the same bucket (NO_ANSWER) on purpose, not an oversight: per the
 * CallerDesk webhook's own documented status mapping (backend/src/modules/telephony/README.md),
 * CallerDesk's "Cancel / No Answer / Not Connected / Abandonedcall" statuses all collapse into our
 * single NO_ANSWER value before they ever reach the database - there is no way to tell a call the
 * customer abandoned in the IVR menu apart from one the agent simply never answered, so a separate
 * "Abandoned" count would not be real data. If CallerDesk ever sends a distinguishing field for
 * this, split it here - do not fabricate a number in the meantime.
 */
function sumFor(byStatus: CallStatusCount[], statuses: CallStatus[]): number {
  const set = new Set(statuses);
  return byStatus.filter((row) => set.has(row.status)).reduce((total, row) => total + row.count, 0);
}

export function inboundBuckets(byStatus: CallStatusCount[]) {
  return {
    answered: sumFor(byStatus, ["COMPLETED"]),
    missedOrAbandoned: sumFor(byStatus, ["NO_ANSWER"]),
    busy: sumFor(byStatus, ["BUSY"]),
  };
}

export function outboundBuckets(byStatus: CallStatusCount[]) {
  return {
    answered: sumFor(byStatus, ["COMPLETED"]),
    noAnswer: sumFor(byStatus, ["NO_ANSWER"]),
    busy: sumFor(byStatus, ["BUSY"]),
    // NOT_REACHABLE folded into "Failed" - the user-facing outcome is the same (no connection was
    // ever made), and the CallerDesk status mapping table treats "Unavailable"/"Congestion"/
    // "Chanunavail" the same way under the hood.
    failed: sumFor(byStatus, ["FAILED", "NOT_REACHABLE"]),
  };
}

export function formatTalkTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
