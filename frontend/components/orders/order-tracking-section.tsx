"use client";

import { Copy, ExternalLink, MapPin, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/order-status";
import { cn } from "@/lib/utils";
import type { OrderTracking, ShipmentTracking, TrackingStage } from "@/lib/api-client/types/orders.types";
import { AccentCard, SectionTitle } from "./order-detail-parts";
import { DetailField, DetailGrid } from "./detail-field";

const NOT_AVAILABLE = "Not available";

const STAGE_TONE: Partial<Record<TrackingStage, string>> = {
  DELIVERED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  OUT_FOR_DELIVERY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  DELIVERY_FAILED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  RTO_INITIATED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  RTO_DELIVERED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  CANCELLED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};
const DEFAULT_TONE = "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200";

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}. Select and copy it manually.`);
  }
}

function ShipmentTrackingCard({ t }: { t: ShipmentTracking }) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4" data-testid="tracking-shipment">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2.5 py-0.5 text-sm font-semibold", STAGE_TONE[t.status.stage] ?? DEFAULT_TONE)} data-testid="tracking-status">
          {t.status.label}
        </span>
        {t.status.providerText && t.status.providerText.toLowerCase() !== t.status.label.toLowerCase() ? <span className="text-xs text-muted-foreground">Shiprocket says: {t.status.providerText}</span> : null}
        {t.live === "live" ? <span className="text-xs text-muted-foreground">· live from Shiprocket</span> : null}
      </div>
      {t.live === "unavailable" ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="tracking-live-note">
          Live scans are unavailable right now ({t.liveError ?? "unknown reason"}). Showing the status last recorded in the CRM.
        </p>
      ) : null}
      {t.live === "none" ? <p className="text-xs text-muted-foreground">No AWB has been assigned yet, so there are no courier scans to show.</p> : null}

      <DetailGrid>
        <DetailField label="Courier partner">{t.courier ?? NOT_AVAILABLE}</DetailField>
        <DetailField label="AWB / tracking number">
          {t.awb ? (
            <span className="inline-flex items-center gap-1">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{t.awb}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => void copy(t.awb!, "AWB")} aria-label="Copy AWB"><Copy /></Button>
            </span>
          ) : (
            NOT_AVAILABLE
          )}
        </DetailField>
        <DetailField label="Shiprocket order ID">{t.shiprocketOrderId ?? NOT_AVAILABLE}</DetailField>
        <DetailField label="Shipment created">{formatDateTime(t.createdAt)}</DetailField>
        <DetailField label="Latest update">{t.latestUpdateAt ? formatDateTime(t.latestUpdateAt) : NOT_AVAILABLE}</DetailField>
        {t.estimatedDelivery ? <DetailField label="Estimated delivery">{formatDate(t.estimatedDelivery)}</DetailField> : null}
      </DetailGrid>

      <div className="flex flex-wrap gap-2">
        {t.trackingUrl ? (
          <>
            <a href={t.trackingUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="open-tracking">
              <ExternalLink data-icon="inline-start" />
              Open Tracking
            </a>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy(t.trackingUrl!, "Tracking link")} data-testid="copy-tracking">
              <Copy data-icon="inline-start" />
              Copy Tracking Link
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{t.awb ? "No public tracking link was provided for this shipment." : "A tracking link appears once the courier assigns an AWB."}</span>
        )}
      </div>

      {t.events.length > 0 ? (
        <ol className="space-y-2 border-l pl-4" aria-label="Delivery timeline" data-testid="tracking-timeline">
          {t.events.map((e, i) => (
            <li key={`${e.stage}-${e.at ?? "x"}-${i}`} className="relative text-sm">
              <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full", i === t.events.length - 1 ? "bg-primary" : "bg-muted-foreground/50")} aria-hidden />
              <p className="font-medium">{e.label}</p>
              <p className="text-xs text-muted-foreground">
                {e.at ? formatDateTime(e.at) : "Time not provided"}
                {e.location ? (
                  <>
                    {" · "}
                    <MapPin className="inline size-3 align-[-1px]" aria-hidden /> {e.location}
                  </>
                ) : null}
                {e.detail && e.detail !== e.label ? ` · ${e.detail}` : ""}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

// "Where is this order?" for Admins, Managers and Telecallers, near the top of the order page. Everything shown comes from the backend's tracking view (shipment rows kept current by the Shiprocket
// webhook plus Shiprocket's live scans); this component never creates a shipment, AWB or courier assignment - that stays in Fulfilment & Shipment below.
export function OrderTrackingSection({ tracking }: { tracking: OrderTracking | undefined }) {
  if (!tracking) return null;
  return (
    <AccentCard accent="green">
      <SectionTitle icon={<Truck />} accent="green" aside={<span className="text-sm text-muted-foreground" data-testid="tracking-headline">{tracking.headline}</span>}>
        Tracking
      </SectionTitle>
      <CardContent className="space-y-3">
        {tracking.state === "NOT_CREATED" ? (
          <div className="space-y-2">
            <p className="text-sm font-medium" data-testid="tracking-not-created">Shipment not created yet</p>
            <p className="text-xs text-muted-foreground">Tracking appears here automatically once a shipment exists. Create one under Fulfilment &amp; Shipment below.</p>
            {tracking.orderEvents.map((e) => (
              <p key={e.stage} className="text-xs text-muted-foreground">{e.label} · {e.at ? formatDateTime(e.at) : ""}</p>
            ))}
          </div>
        ) : (
          <>
            {tracking.orderEvents.length > 0 ? <p className="text-xs text-muted-foreground">{tracking.orderEvents.map((e) => `${e.label} ${e.at ? formatDateTime(e.at) : ""}`).join(" · ")}</p> : null}
            {tracking.shipments.map((t) => (
              <ShipmentTrackingCard key={t.shipmentId} t={t} />
            ))}
          </>
        )}
      </CardContent>
    </AccentCard>
  );
}
