import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField, DetailGrid } from "./detail-field";
import { CreateShipmentButton, ShipmentActions } from "./shipment-actions";
import { ShipmentStatusBadge } from "./shipment-status-badge";
import { formatDate, formatDateTime } from "@/lib/order-status";
import type { ShipmentDetail } from "@/lib/api-client/types/orders.types";

const NOT_AVAILABLE = "Not available";

const SOURCE_LABELS = { SHOPIFY: "Shopify", SHIPROCKET: "Shiprocket (created here)" } as const;

function ShipmentCard({ shipment }: { shipment: ShipmentDetail }) {
  const source = shipment.source === "SHOPIFY" || shipment.source === "SHIPROCKET" ? SOURCE_LABELS[shipment.source] : null;
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShipmentStatusBadge status={shipment.status} />
        {source ? <span className="text-xs text-muted-foreground">{source}</span> : null}
        {shipment.providerStatus ? <span className="text-xs text-muted-foreground">· Shiprocket says: {shipment.providerStatus}</span> : null}
      </div>
      {shipment.linkedShipmentId ? (
        <p className="text-xs text-muted-foreground">The same parcel is also tracked directly in Shiprocket (same AWB) - see that shipment.</p>
      ) : null}
      <DetailGrid>
        <DetailField label="Courier">{shipment.courier ?? NOT_AVAILABLE}</DetailField>
        <DetailField label="Tracking / AWB number">
          {shipment.trackingNumber ? <span className="font-mono text-xs">{shipment.trackingNumber}</span> : NOT_AVAILABLE}
        </DetailField>
        <DetailField label="Tracking link">
          {shipment.trackingUrl ? (
            <a href={shipment.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              Track shipment
            </a>
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
}

export function OrderShipmentSection({ shipments, orderId, orderNumber, orderStatus, currency }: OrderShipmentSectionProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Fulfilment & Shipment</CardTitle>
        <CreateShipmentButton orderId={orderId} orderNumber={orderNumber} orderStatus={orderStatus} currency={currency} shipments={shipments} />
      </CardHeader>
      <CardContent className="space-y-3">
        {shipments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This order has no shipment recorded yet - details appear automatically once courier and tracking
            information sync from Shopify, or when a shipment is created here in Shiprocket.
          </p>
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
    </Card>
  );
}
