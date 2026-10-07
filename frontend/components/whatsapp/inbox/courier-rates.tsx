"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/order-status";
import { DIMENSIONS_REQUIRED, formatDimensions, type DimensionsCm } from "@/lib/package-dimensions";
import { WEIGHT_REQUIRED, formatKg, sortCouriers } from "@/lib/parcel-weight";
import { courierKey } from "@/lib/shipping-charge";
import type { CourierOption, ServiceabilityResult } from "@/lib/api-client/types/delivery.types";

type Tone = "ok" | "bad" | "warn" | "muted" | "busy";
const TONES: Record<Tone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  bad: "text-destructive",
  warn: "text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground",
  busy: "text-muted-foreground",
};
function Line({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <p className={cn("text-xs", TONES[tone])}>{children}</p>;
}

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : formatMoney(String(n)));
const eta = (o: CourierOption) => (o.etd ? o.etd : o.days !== null ? `${o.days} day${o.days === 1 ? "" : "s"}` : "—");

/**
 * The couriers Shiprocket returned for this parcel, each with ITS charge, exactly as returned. The CRM never computes, defaults or adjusts a
 * charge. COD charge and tax columns appear only when Shiprocket returned those values; otherwise just the total charge is shown.
 */
export function CourierTable({ weightKg, dimensions, options, selectedKey, onSelect }: { weightKg?: number; dimensions?: DimensionsCm; options: CourierOption[]; selectedKey?: string | null; onSelect?: (key: string) => void }) {
  if (options.length === 0) return null;
  const showCod = options.some((o) => o.codCharge !== null && o.codCharge !== undefined);
  const showTax = options.some((o) => o.tax !== null && o.tax !== undefined);
  return (
    <div className="mt-2 rounded-lg border text-sm" data-testid="courier-table">
      {weightKg !== undefined ? (
        <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          Parcel Weight: {formatKg(weightKg)}
          {dimensions ? ` · Dimensions: ${formatDimensions(dimensions)}` : ""}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {onSelect ? <th className="w-8 px-3 py-1.5" aria-label="Selected" /> : null}
              <th className="px-3 py-1.5 font-medium">Courier</th>
              <th className="px-3 py-1.5 text-right font-medium">Shipping Charge</th>
              {showCod ? <th className="px-3 py-1.5 text-right font-medium">COD Charge</th> : null}
              {showTax ? <th className="px-3 py-1.5 text-right font-medium">Tax</th> : null}
              <th className="px-3 py-1.5 text-right font-medium">ETA</th>
            </tr>
          </thead>
          <tbody>
            {sortCouriers(options).map((o, i) => (
              <tr key={`${o.name ?? "courier"}-${i}`} className={cn("border-t", onSelect && o.rate !== null && "cursor-pointer", selectedKey === courierKey(o) && "bg-primary/5")} data-selected={selectedKey === courierKey(o) ? "true" : undefined} onClick={onSelect && o.rate !== null ? () => onSelect(courierKey(o)) : undefined}>
                {onSelect ? (
                  <td className="px-3 py-1.5">
                    <input type="radio" name="courier" aria-label={`Select ${o.name ?? "courier"}`} checked={selectedKey === courierKey(o)} disabled={o.rate === null} onChange={() => onSelect(courierKey(o))} />
                  </td>
                ) : null}
                <td className="px-3 py-1.5">{o.name ?? "Courier"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{money(o.rate)}</td>
                {showCod ? <td className="px-3 py-1.5 text-right tabular-nums">{money(o.codCharge)}</td> : null}
                {showTax ? <td className="px-3 py-1.5 text-right tabular-nums">{money(o.tax)}</td> : null}
                <td className="px-3 py-1.5 text-right tabular-nums">{eta(o)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">Charges are Shiprocket&apos;s rates for this parcel, shown as returned.</p>
    </div>
  );
}

export type RateMissing = "weight" | "dimensions" | "value" | null;

/** Automatic rate calculation, as the operator sees it: what is missing, "Calculating…", or Shiprocket's couriers. */
export function ServiceabilityLine({
  pincodeState,
  missing,
  calculating,
  failed,
  result,
  parcelWeightKg,
  dimensions,
  onRefresh,
  selectedKey,
  onSelect,
}: {
  /** The courier whose Shiprocket charge is the order's shipping charge (key from courierKey), and how to change it. */
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  pincodeState: string;
  /** The first input still preventing a rate request (null = everything is available). */
  missing: RateMissing;
  calculating: boolean;
  failed?: boolean;
  /** The result for EXACTLY the current inputs (undefined while calculating). */
  result: ServiceabilityResult | undefined;
  parcelWeightKg?: number;
  dimensions?: DimensionsCm;
  /** Manual "Check Courier Availability" - re-requests the rates for the current inputs. */
  onRefresh?: () => void;
}) {
  if (pincodeState !== "valid") return null;
  if (missing === "weight") {
    return (
      <div data-testid="serviceability-needs-weight">
        <Line tone="muted">Courier serviceability requires shipment weight — enter the parcel weight below.</Line>
        <Line tone="muted">{WEIGHT_REQUIRED}</Line>
      </div>
    );
  }
  if (missing === "dimensions") {
    return (
      <div data-testid="serviceability-needs-dimensions">
        <Line tone="muted">{DIMENSIONS_REQUIRED}</Line>
      </div>
    );
  }
  if (missing === "value") {
    return (
      <div data-testid="serviceability-needs-value">
        <Line tone="muted">Add a product with a price so the order value is known — shipping rates need it.</Line>
      </div>
    );
  }
  if (calculating || (!result && !failed)) {
    return (
      <div data-testid="serviceability-calculating">
        <Line tone="busy">Calculating shipping rates...</Line>
      </div>
    );
  }
  if (failed || !result) {
    return (
      <div data-testid="serviceability">
        <Line tone="warn">Could not calculate shipping rates right now. You can still continue.</Line>
        {onRefresh ? (
          <Button type="button" variant="outline" size="sm" className="mt-2 w-fit" onClick={onRefresh}>
            Check Courier Availability
          </Button>
        ) : null}
      </div>
    );
  }
  if (result.status === "serviceable") {
    const range = result.minDays !== null ? ` · ${result.minDays === result.maxDays || result.maxDays === null ? `${result.minDays}` : `${result.minDays}–${result.maxDays}`} days` : "";
    const from = result.cheapestRate !== null ? ` · from ${formatMoney(String(result.cheapestRate))}` : "";
    return (
      <div data-testid="serviceability">
        <Line tone="ok">
          Delivery serviceable — {result.couriers} courier{result.couriers === 1 ? "" : "s"} available{range}
          {from}
        </Line>
        <div className="mt-2 grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Available Couriers</p>
            {onRefresh ? (
              <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
                Check Courier Availability
              </Button>
            ) : null}
          </div>
          {!dimensions ? (
            <p className="text-xs text-muted-foreground" data-testid="weight-only-note">
              Rates are for the parcel weight only. Enter the final packed parcel dimensions to include volumetric weight.
            </p>
          ) : null}
          <CourierTable weightKg={parcelWeightKg} dimensions={dimensions} options={result.courierOptions ?? []} selectedKey={selectedKey} onSelect={onSelect} />
        </div>
      </div>
    );
  }
  if (result.status === "not_serviceable") {
    return (
      <div data-testid="serviceability">
        <Line tone={result.blocksOrder ? "bad" : "warn"}>
          {result.message ?? "This pincode is currently not serviceable for delivery."}
          {result.blocksOrder ? "" : " The order can still be created."}
        </Line>
      </div>
    );
  }
  return (
    <div data-testid="serviceability">
      <Line tone="warn">{result.message ?? "Could not check delivery right now."} You can still continue.</Line>
    </div>
  );
}
