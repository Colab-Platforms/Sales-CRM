import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField, DetailGrid } from "./detail-field";
import { ShipmentStatusBadge } from "./shipment-status-badge";
import { formatDate, formatDateTime } from "@/lib/order-status";
import type { ShipmentDetail } from "@/lib/api-client/types/orders.types";

const NOT_AVAILABLE = "Not available";

function ShipmentCard({ shipment }: { shipment: ShipmentDetail }) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <ShipmentStatusBadge status={shipment.status} />
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
        <DetailField label="Shipped">{shipment.shippedAt ? formatDateTime(shipment.shippedAt) : NOT_AVAILABLE}</DetailField>
        <DetailField label="Expected delivery">{shipment.expectedDeliveryAt ? formatDate(shipment.expectedDeliveryAt) : NOT_AVAILABLE}</DetailField>
        <DetailField label="Delivered">{shipment.deliveredAt ? formatDateTime(shipment.deliveredAt) : NOT_AVAILABLE}</DetailField>
        {shipment.status === "RETURNED" ? (
          <DetailField label="Returned">{shipment.returnedAt ? formatDateTime(shipment.returnedAt) : NOT_AVAILABLE}</DetailField>
        ) : null}
      </DetailGrid>
    </div>
  );
}

export function OrderShipmentSection({ shipments }: { shipments: ShipmentDetail[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fulfilment & Shipment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {shipments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not configured. This order has no shipment recorded yet - details appear automatically once courier and
            tracking information sync from Shopify.
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
