import type { ChartInterval } from "@/lib/api-client/types/orders-dashboard.types";

// Pure chart maths for the Orders & Revenue chart (bars = a count, dark line = money). Kept out of the component so it can be tested. A bucket the CRM holds no data for has null numbers: it gets NO bar and
// NO line point (the line breaks there) - it is never drawn as zero.

export interface ChartPoint {
  /** First day of the bucket, YYYY-MM-DD. */
  key: string;
  bar: number | null;
  line: number | null;
  available: boolean;
  partial: boolean;
}

export interface ChartLayout {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export const DEFAULT_LAYOUT: ChartLayout = { width: 760, height: 280, padLeft: 44, padRight: 56, padTop: 14, padBottom: 34 };

/** A "nice" axis maximum (1, 2, 5 x 10^n) and four ticks from zero to it. An all-zero series still gets a usable 0-4 axis. */
export function niceAxis(maxValue: number): { max: number; ticks: number[] } {
  const m = Math.max(maxValue, 0);
  if (m === 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const exp = Math.pow(10, Math.floor(Math.log10(m)));
  const f = m / exp;
  const nice = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
  return { max: nice, ticks: [0, 1, 2, 3, 4].map((i) => (nice * i) / 4) };
}

export interface ChartGeometry {
  bars: { key: string; x: number; y: number; w: number; h: number; value: number; partial: boolean }[];
  /** Missing buckets: a small hatched marker on the baseline, so a gap in the data is visible and distinct from a zero bar. */
  gaps: { key: string; x: number; w: number }[];
  /** Separate segments: the line is broken wherever a bucket has no data. */
  segments: { x: number; y: number; key: string; value: number }[][];
  leftTicks: { value: number; y: number }[];
  rightTicks: { value: number; y: number }[];
  baseY: number;
  step: number;
  /** Which bucket indexes get an x-axis label (thinned so the labels never overlap). */
  labelIdx: number[];
}

export function chartGeometry(points: ChartPoint[], layout: ChartLayout = DEFAULT_LAYOUT): ChartGeometry {
  const { width, height, padLeft, padRight, padTop, padBottom } = layout;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const baseY = padTop + plotH;
  const n = Math.max(points.length, 1);
  const step = plotW / n;
  const bw = Math.max(2, Math.min(40, step * 0.62));
  const left = niceAxis(Math.max(0, ...points.map((p) => p.bar ?? 0)));
  const right = niceAxis(Math.max(0, ...points.map((p) => p.line ?? 0)));
  const bars: ChartGeometry["bars"] = [];
  const gaps: ChartGeometry["gaps"] = [];
  const segments: ChartGeometry["segments"] = [];
  let current: ChartGeometry["segments"][number] = [];
  points.forEach((p, i) => {
    const cx = padLeft + step * (i + 0.5);
    if (p.bar === null || !p.available) {
      gaps.push({ key: p.key, x: cx - bw / 2, w: bw });
    } else {
      const h = (p.bar / left.max) * plotH;
      bars.push({ key: p.key, x: cx - bw / 2, y: baseY - h, w: bw, h, value: p.bar, partial: p.partial });
    }
    if (p.line === null || !p.available) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push({ x: cx, y: baseY - (p.line / right.max) * plotH, key: p.key, value: p.line });
    }
  });
  if (current.length) segments.push(current);
  const every = Math.max(1, Math.ceil(points.length / 10));
  return {
    bars,
    gaps,
    segments,
    leftTicks: left.ticks.map((value) => ({ value, y: baseY - (value / left.max) * plotH })),
    rightTicks: right.ticks.map((value) => ({ value, y: baseY - (value / right.max) * plotH })),
    baseY,
    step,
    labelIdx: points.map((_, i) => i).filter((i) => i % every === 0),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "25 Oct" for a day or week start, "Oct 2026" for a month. */
export function bucketLabel(key: string, interval: ChartInterval): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return interval === "monthly" ? `${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}

/** What a bucket is called in a tooltip / for screen readers: the part of it inside the range. */
export function bucketTitle(from: string, to: string, interval: ChartInterval): string {
  if (from === to) return bucketLabel(from, "daily");
  return `${bucketLabel(from, interval === "monthly" ? "daily" : interval)} - ${bucketLabel(to, "daily")}`;
}
