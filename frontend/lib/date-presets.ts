// Quick date ranges shared by every report, dashboard and calendar, so "Last Week" means the same
// thing everywhere. All days are India business days (IST, UTC+5:30), the same zone the backend uses;
// ranges are inclusive of both ends. Weeks run Monday to Sunday.

export type DatePreset =
  | "today"
  | "yesterday"
  | "dayBefore"
  | "5d"
  | "7d"
  | "30d"
  | "thisWeek"
  | "lastWeek"
  | "month"
  | "lastMonth"
  | "single"
  | "custom";

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  dayBefore: "Day Before Yesterday",
  "5d": "Last 5 Days",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  thisWeek: "This Week",
  lastWeek: "Last Week",
  month: "This Month",
  lastMonth: "Last Month",
  single: "Single Date",
  custom: "Custom Range",
};

export const DATE_PRESETS = Object.keys(DATE_PRESET_LABELS) as DatePreset[];

const TZ_OFFSET_MINUTES = 330;
const DAY_MS = 86_400_000;

/** Today's date in IST, YYYY-MM-DD. */
export const istToday = (now = new Date()) => new Date(now.getTime() + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

export const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Monday of the week holding this date. */
export function weekStart(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return shiftDay(ymd, -((dow + 6) % 7));
}

export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 8)}01`;
}

export function monthEnd(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export interface PresetInput {
  preset: DatePreset;
  /** For "single". */
  single?: string;
  /** For "custom". */
  from?: string;
  to?: string;
}

/**
 * The inclusive range a preset stands for. Ranges never run past today: "This Week" / "This Month" end today.
 * A custom range given back to front is swapped rather than rejected.
 */
export function resolvePreset(p: PresetInput, now = new Date()): { from: string; to: string } {
  const today = istToday(now);
  switch (p.preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case "dayBefore":
      return { from: shiftDay(today, -2), to: shiftDay(today, -2) };
    case "5d":
      return { from: shiftDay(today, -4), to: today };
    case "7d":
      return { from: shiftDay(today, -6), to: today };
    case "30d":
      return { from: shiftDay(today, -29), to: today };
    case "thisWeek":
      return { from: weekStart(today), to: today };
    case "lastWeek": {
      const start = shiftDay(weekStart(today), -7);
      return { from: start, to: shiftDay(start, 6) };
    }
    case "month":
      return { from: monthStart(today), to: today };
    case "lastMonth": {
      const end = shiftDay(monthStart(today), -1);
      return { from: monthStart(end), to: end };
    }
    case "single": {
      const d = p.single || today;
      return { from: d, to: d };
    }
    case "custom": {
      const from = p.from || shiftDay(today, -6);
      const to = p.to || today;
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

/** Why a draft range cannot be applied, or null when it is fine. */
export function presetError(p: PresetInput, now = new Date()): string | null {
  const today = istToday(now);
  if (p.preset === "single") {
    if (!p.single) return "Pick a date.";
    if (p.single > today) return "The date cannot be in the future.";
  }
  if (p.preset === "custom") {
    if (!p.from || !p.to) return "Pick both From and To dates.";
    if (p.from > p.to) return "From date must not be after To date.";
    if (p.to > today) return "To date cannot be in the future.";
  }
  return null;
}

export const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
