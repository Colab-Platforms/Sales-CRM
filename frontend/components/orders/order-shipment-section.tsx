import { Truck } from "lucide-react";
import { CardContent } from "@/components/ui/card";
import { AccentCard, EmptyState, LinkButton, SectionTitle } from "./order-detail-parts";
import { DetailField, DetailGrid } from "./detail-field";
import { CreateShipmentButton, ShipmentActions } from "./shipment-actions";
import { ShipmentStatusBadge } from "./shipment-status-badge";
import { formatDate, formatDateTime } from "@/lib/order-status";
import { formatKg } from "@/lib/parcel-weight";
import type { ShipmentDetail } from "@/lib/api-client/types/orders.types";

const NOT_AVAILABLE = "Not available";

const SOURCE_LABELS = { SHOPIFY: "Shopify", SHIPROCKET: "Shiprocket (created here)" } as const;

function ShipmentCard({ shipment }: { shipment: ShipmentDetail }) {
  const source = shipment.source === "SHOPIFY" || shipment.source === "SHIPROCKET" ? SOURCE_LABELS[shipment.source] : null;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShipmentStatusBadge status={shipment.status} />
        {source ? <span className="text-xs text-muted-foreground">{source}</span> : null}
        {shipment.providerStatus ? <span className="text-xs text-muted-foreground">· Shiprocket says: {shipment.providerStatus}</span> : null}
      </div>
      {shipment.linkedShipmentId ? (
        <p className="text-xs text-muted-foreground">The same parcel is also tracked directly in Shiprocket (same AWB) - see that shipment.</p>
      ) : null}
      {shipment.liveTracking ? (
        shipment.liveTracking.tracking ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs">
            <span className="font-medium">Live from Shiprocket:</span> {shipment.liveTracking.tracking.currentStatus ?? "Status not available"}
            {shipment.liveTracking.tracking.courierName ? ` · ${shipment.liveTracking.tracking.courierName}` : ""}
          </p>
        ) : (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Live Shiprocket status unavailable: {shipment.liveTracking.error ?? "unknown reason"}
          </p>
        )
      ) : null}
      <DetailGrid>
        <DetailField label="Courier">{shipment.courier ?? NOT_AVAILABLE}</DetailField>
        {formatKg(shipment.weightKg) ? <DetailField label="Parcel Weight">{formatKg(shipment.weightKg)}</DetailField> : null}
        <DetailField label="Tracking / AWB number">
          {shipment.trackingNumber ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{shipment.trackingNumber}</span> : NOT_AVAILABLE}
        </DetailField>
        <DetailField label="Tracking link">
          {shipment.trackingUrl ? (
            <LinkButton href={shipment.trackingUrl} external>
              Track shipment →
            </LinkButton>
          ) : (
            NOT_AVAILABLE
          )}
        </DetailField>
        {shipment.pickupScheduledAt ? <DetailField label="Pickup scheduled">{formatDateTime(shipment.pickupScheduledAt)}</DetailField> : null}
        <DetailField label="Shipped">{shipment.shippedAt ? formatDateTime(shipment.shippedAt) : NOT_AVAILABLE}</DetailField>
        <DetailField label="Expected delivery">{shipment.expectedDeliveryAt ? formatDate(shipment.expectedDeliveryAt) : NOT_AVAILABLE}</DetailField>
        <DetailField label="Delivered">{shipment.deliveredAt ? formatDateTime(shipment.deliveredAt) : NOT_AVAILABLE}</DetailField>
        {shipment.status === "RETURNED" ? (
          <DetailField label="Returned">{shipment.returnedAt ? formatDateTime(shipment.returnedAt) : NOT_AVAILABLE}</DetailField>
        ) : null}
      </DetailGrid>
      <ShipmentActions shipment={shipment} />
    </div>
  );
}

interface OrderShipmentSectionProps {
  shipments: ShipmentDetail[];
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  currency: string;
  parcelWeightKg?: string | null;
  items?: { quantity: number; unitWeightKg?: string | null; unitDimensionsCm?: { lengthCm: string; widthCm: string; heightCm: string } | null }[];
  orderValue?: number;
  pincode?: string | null;
  cod?: boolean;
}

export function OrderShipmentSection({ shipments, orderId, orderNumber, orderStatus, currency, parcelWeightKg, items, orderValue, pincode, cod }: OrderShipmentSectionProps) {
  return (
    <AccentCard accent="blue">
      <SectionTitle icon={<Truck />} accent="blue" aside={<CreateShipmentButton orderId={orderId} orderNumber={orderNumber} orderStatus={orderStatus} currency={currency} shipments={shipments} parcelWeightKg={parcelWeightKg} items={items} orderValue={orderValue} pincode={pincode} cod={cod} />}>
        Fulfilment &amp; Shipment
      </SectionTitle>
      <CardContent className="space-y-3">
        {shipments.length === 0 ? (
          <EmptyState title="No shipment recorded yet" message="Shipment details will appear automatically when courier and tracking information syncs from Shopify, or when a shipment is created here in Shiprocket." />
        ) : (
          <>
            {shipments.map((shipment) => (
              <ShipmentCard key={shipment.id} shipment={shipment} />
            ))}
            <p className="text-xs text-muted-foreground">
              For the full sequence of status changes, see status history below.
            </p>
          </>
        )}
      </CardContent>
    </AccentCard>
  );
}
