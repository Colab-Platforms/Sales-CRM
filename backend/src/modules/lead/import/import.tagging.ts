import { LeadWorkingStatus } from "../../../../generated/prisma/enums.js";
import { normalizeHeader } from "./import.columns.js";

// LEAD STATUS FROM THE "Tagging" COLUMN of a customer file. The status comes from that column and nowhere else: it is found by its header name, never through the editable column mapping, so neither a manual choice nor a
// remembered mapping can point the status at "Feedback" or any other column. The column also stays on the lead as ordinary file data, exactly as written.
// A blank or unrecognised value sets nothing: the new lead gets the CRM's normal default status. The importer only ever creates leads, so no existing lead's status is touched.

const TAGGING_HEADER = "tagging";

/** Every accepted spelling, written without spaces, hyphens, underscores or dots, in lower case. An explicit list, with no guessing: "not interested" can never be read as "interested". */
const ALIASES: Partial<Record<LeadWorkingStatus, string[]>> = {
  NEW: ["new"],
  RINGING: ["ringing"],
  BUSY: ["busy"],
  CALL_BACK: ["callback"],
  FOLLOW_UP: ["followup"],
  SWITCHED_OFF: ["switchoff", "switchedoff"],
  DND: ["dnd"],
  NOT_REACHABLE: ["notreachable", "notrechable"],
  INTERESTED: ["interested", "intrested"],
  NOT_INTERESTED: ["notinterested", "notintersted", "notintrested"],
  CONVERTED: ["converted"],
};

const BY_ALIAS = new Map<string, LeadWorkingStatus>(Object.entries(ALIASES).flatMap(([status, names]) => names!.map((name) => [name, status as LeadWorkingStatus] as const)));

/** The CRM status a Tagging value stands for; null when it is blank or not recognised. */
export function statusFromTag(value: string): LeadWorkingStatus | null {
  return BY_ALIAS.get(value.toLowerCase().replace(/[\s._-]/g, "")) ?? null;
}

/** The file's Tagging column, as its header is written; null when the file has none. */
export const taggingColumn = (headers: readonly string[]): string | null => headers.find((h) => normalizeHeader(h) === TAGGING_HEADER) ?? null;

/** The status for one file row (keyed by header); null leaves the CRM default. */
export function statusFromRow(cells: Record<string, string>): LeadWorkingStatus | null {
  const column = taggingColumn(Object.keys(cells));
  return column ? statusFromTag(cells[column] ?? "") : null;
}

const MAX_LISTED_VALUES = 20;

export type TaggingSummary = {
  column: string;
  recognized: number;
  blank: number;
  unrecognized: number;
  /** How many leads get each status. Blank and unrecognised rows are not listed here: they get the default status. */
  statuses: { status: LeadWorkingStatus; count: number }[];
  /** The values that were not recognised, most frequent first (at most 20 of them). */
  unrecognizedValues: { value: string; count: number }[];
};

/** Counts Tagging values, fed one value (or an already grouped count) at a time. */
export function taggingTally(column: string) {
  const statuses = new Map<LeadWorkingStatus, number>();
  const unknown = new Map<string, number>();
  let recognized = 0;
  let blank = 0;
  let unrecognized = 0;
  return {
    add(raw: string | null | undefined, count = 1) {
      const value = (raw ?? "").trim();
      if (!value) {
        blank += count;
        return;
      }
      const status = statusFromTag(value);
      if (status) {
        recognized += count;
        statuses.set(status, (statuses.get(status) ?? 0) + count);
      } else {
        unrecognized += count;
        const shown = value.slice(0, 100);
        unknown.set(shown, (unknown.get(shown) ?? 0) + count);
      }
    },
    summary(): TaggingSummary {
      return {
        column,
        recognized,
        blank,
        unrecognized,
        statuses: [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
        unrecognizedValues: [...unknown].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, MAX_LISTED_VALUES),
      };
    },
  };
}
