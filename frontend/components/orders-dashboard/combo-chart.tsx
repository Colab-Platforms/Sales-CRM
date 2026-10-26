import type { ChartInterval } from "@/lib/api-client/types/orders-dashboard.types";
import { DEFAULT_LAYOUT, bucketLabel, bucketTitle, chartGeometry, type ChartPoint } from "./chart-geometry";

export interface ComboPoint extends ChartPoint {
  from: string;
  to: string;
}

const compact = (n: number) => (n >= 10_000_000 ? `${+(n / 10_000_000).toFixed(1)}Cr` : n >= 100_000 ? `${+(n / 100_000).toFixed(1)}L` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n * 10) / 10));

/**
 * Bars (green) = a count on the left axis, dark line = money on the right axis, one point per bucket. No chart library: plain SVG, so it adds no dependency. A bucket with no data has no bar and breaks the line
 * (a hatched marker sits on the baseline) - it is never drawn as zero. Every bar and point has a <title> tooltip, and `summary` is the accessible description of the whole chart.
 */
export function ComboChart({ points, interval, barLabel, lineLabel, formatLine, summary, testId }: { points: ComboPoint[]; interval: ChartInterval; barLabel: string; lineLabel: string; formatLine: (n: number) => string; summary: string; testId: string }) {
  const L = DEFAULT_LAYOUT;
  const g = chartGeometry(points, L);
  const byKey = new Map(points.map((p) => [p.key, p]));
  return (
    <div className="w-full overflow-x-auto" data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm bg-emerald-500" />{barLabel}</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-slate-800 dark:bg-slate-200" />{lineLabel}</span>
        {g.gaps.length > 0 ? <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm border border-dashed border-muted-foreground" />No data for this period</span> : null}
      </div>
      <svg viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label={summary} className="h-auto w-full min-w-[520px]">
        <defs>
          <pattern id={`${testId}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="none" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
          </pattern>
        </defs>
        {g.leftTicks.map((t) => (
          <g key={`l${t.value}`}>
            <line x1={L.padLeft} x2={L.width - L.padRight} y1={t.y} y2={t.y} stroke="currentColor" opacity="0.1" />
            <text x={L.padLeft - 6} y={t.y + 3} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.6">{compact(t.value)}</text>
          </g>
        ))}
        {g.rightTicks.map((t) => (
          <text key={`r${t.value}`} x={L.width - L.padRight + 6} y={t.y + 3} fontSize="10" fill="currentColor" opacity="0.6">{compact(t.value)}</text>
        ))}
        {g.bars.map((b) => {
          const p = byKey.get(b.key)!;
          return (
            <rect key={b.key} x={b.x} y={b.y} width={b.w} height={Math.max(b.h, b.value > 0 ? 1 : 0)} rx="2" className="fill-emerald-500" opacity={p.partial ? 0.55 : 1} data-testid="chart-bar">
              <title>{`${bucketTitle(p.from, p.to, interval)}: ${p.bar} ${barLabel.toLowerCase()}${p.line !== null ? `, ${formatLine(p.line)}` : ""}${p.partial ? " (partial - data incomplete)" : ""}`}</title>
            </rect>
          );
        })}
        {g.gaps.map((gap) => {
          const p = byKey.get(gap.key)!;
          return (
            <rect key={gap.key} x={gap.x} y={g.baseY - 14} width={gap.w} height={14} className="text-muted-foreground" fill={`url(#${testId}-hatch)`} stroke="currentColor" strokeDasharray="2 2" opacity="0.7" data-testid="chart-gap">
              <title>{`${bucketTitle(p.from, p.to, interval)}: no data in the CRM for this period`}</title>
            </rect>
          );
        })}
        {g.segments.map((seg, i) => (
          <g key={i}>
            {seg.length > 1 ? <polyline points={seg.map((s) => `${s.x},${s.y}`).join(" ")} fill="none" className="stroke-slate-800 dark:stroke-slate-200" strokeWidth="2" strokeLinejoin="round" data-testid="chart-line" /> : null}
            {seg.map((s) => (
              <circle key={s.key} cx={s.x} cy={s.y} r="3" className="fill-white stroke-slate-800 dark:fill-slate-900 dark:stroke-slate-200" strokeWidth="2" data-testid="chart-point">
                <title>{`${bucketTitle(byKey.get(s.key)!.from, byKey.get(s.key)!.to, interval)}: ${formatLine(s.value)}`}</title>
              </circle>
            ))}
          </g>
        ))}
        <line x1={L.padLeft} x2={L.width - L.padRight} y1={g.baseY} y2={g.baseY} stroke="currentColor" opacity="0.3" />
        {g.labelIdx.map((i) => (
          <text key={points[i]!.key} x={L.padLeft + g.step * (i + 0.5)} y={L.height - 12} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.7">{bucketLabel(points[i]!.key, interval)}</text>
        ))}
      </svg>
    </div>
  );
}
