"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { customerDetailHref, orderDetailHref } from "@/components/orders/orders-table";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { ShipmentActions } from "@/components/orders/shipment-actions";
import { ShipmentStatusBadge } from "@/components/orders/shipment-status-badge";
import { PAYMENT_MODE_LABELS, formatDateTime, formatMoney } from "@/lib/order-status";
import { useShiprocketShipment } from "@/hooks/useShiprocketShipments";
import type { ShipmentDetail as ShipmentActionsShape } from "@/lib/api-client/types/orders.types";
import type { ShipmentDetailResult } from "@/lib/api-client/types/shiprocket.types";

const NOT_AVAILABLE = "Not available";

// ShipmentActions (order detail's own component, reused as-is - not duplicated) takes the ShipmentDetail shape from
// orders.types.ts, which names the AWB field "trackingNumber". Every centralized-listing shipment is one this CRM
// created through Shiprocket (the backend only ever returns externalSource SHIPROCKET rows here), so `source` is
// filled in as a real, known fact, not a guess.
function toShipmentActionsShape(shipment: ShipmentDetailResult): ShipmentActionsShape {
  return {
    id: shipment.id,
    status: shipment.status,
    courier: shipment.courier,
    trackingNumber: shipment.awb,
    trackingUrl: shipment.trackingUrl,
    shippedAt: shipment.shippedAt,
    expectedDeliveryAt: shipment.expectedDeliveryAt,
    deliveredAt: shipment.deliveredAt,
    returnedAt: shipment.returnedAt,
    createdAt: shipment.createdAt,
    source: "SHIPROCKET",
    providerStatus: shipment.providerStatus,
    labelUrl: shipment.labelUrl,
    pickupScheduledAt: shipment.pickupScheduledAt,
    shiprocketOrderId: shipment.shiprocketOrderId,
    linkedShipmentId: null,
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading shipment">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

export function ShiprocketDetailSheet({ shipmentId, onOpenChange }: { shipmentId: string | null; onOpenChange: (id: string | null) => void }) {
  const { data: shipment, isLoading, error } = useShiprocketShipment(shipmentId);

  return (
    <Sheet open={shipmentId !== null} onOpenChange={(open) => !open && onOpenChange(null)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Shipment details</SheetTitle>
          <SheetDescription>{shipment ? `Order ${shipment.order.orderNumber}` : "Loading…"}</SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-4">
          {isLoading ? (
            <DetailSkeleton />
          ) : error || !shipment ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error ?? "This shipment could not be found."}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <ShipmentStatusBadge status={shipment.status} />
                {shipment.providerStatus ? <span className="text-xs text-muted-foreground">Shiprocket says: {shipment.providerStatus}</span> : null}
              </div>

              <Section title="Shipment information">
                <DetailGrid>
                  <DetailField label="Shipment ID">
                    <span className="font-mono text-xs break-all">{shipment.id}</span>
                  </DetailField>
                  <DetailField label="Order number">
                    <Link href={orderDetailHref(shipment.order.id)} className="text-primary hover:underline">
                      {shipment.order.orderNumber}
                    </Link>
                  </DetailField>
                  <DetailField label="AWB">{shipment.awb ? <span className="font-mono text-xs">{shipment.awb}</span> : NOT_AVAILABLE}</DetailField>
                  <DetailField label="Courier">{shipment.courier ?? NOT_AVAILABLE}</DetailField>
                  <DetailField label="Shiprocket order ID">{shipment.shiprocketOrderId ?? NOT_AVAILABLE}</DetailField>
                  <DetailField label="Created">{formatDateTime(shipment.createdAt)}</DetailField>
                  <DetailField label="Last updated">{formatDateTime(shipment.updatedAt)}</DetailField>
                </DetailGrid>
              </Section>

              <Separator />

              <Section title="Customer">
                <DetailGrid>
                  <DetailField label="Name">
                    <Link href={customerDetailHref(shipment.customer.leadId)} className="text-primary hover:underline">
                      {shipment.customer.name}
                    </Link>
                  </DetailField>
                  <DetailField label="Mobile">{shipment.customer.mobile ?? NOT_AVAILABLE}</DetailField>
                  {shipment.customerEmail ? <DetailField label="Email">{shipment.customerEmail}</DetailField> : null}
                </DetailGrid>
              </Section>

              <Separator />

              <Section title="Delivery">
                <DetailGrid>
                  <DetailField label="Address">
                    {[shipment.destinationAddress1, shipment.destinationAddress2].filter(Boolean).join(", ") || NOT_AVAILABLE}
                  </DetailField>
                  <DetailField label="City">{shipment.destinationCity ?? NOT_AVAILABLE}</DetailField>
                  <DetailField label="State">{shipment.destinationState ?? NOT_AVAILABLE}</DetailField>
                  <DetailField label="Pincode">{shipment.destinationPincode ?? NOT_AVAILABLE}</DetailField>
                  <DetailField label="Country">{shipment.destinationCountry ?? NOT_AVAILABLE}</DetailField>
                </DetailGrid>
              </Section>

              <Separator />

              <Section title="Package">
                <p className="text-sm text-muted-foreground">
                  Weight and dimensions are sent to Shiprocket when the shipment is created, but the CRM does not store them back on the record, so they can not be shown here.
                </p>
              </Section>

              <Separator />

              <Section title="Payment">
                <DetailGrid>
                  <DetailField label="Type">{shipment.paymentMode ? PAYMENT_MODE_LABELS[shipment.paymentMode] : NOT_AVAILABLE}</DetailField>
                  <DetailField label="Order amount">{formatMoney(shipment.amount, shipment.currency)}</DetailField>
                </DetailGrid>
              </Section>

              <Separator />

              <Section title="Tracking">
                <DetailGrid>
                  <DetailField label="Latest tracking status">{shipment.providerStatus ?? "Not yet reported by Shiprocket"}</DetailField>
                  <DetailField label="As of">{formatDateTime(shipment.updatedAt)}</DetailField>
                  <DetailField label="Expected delivery">{shipment.expectedDeliveryAt ? formatDateTime(shipment.expectedDeliveryAt) : NOT_AVAILABLE}</DetailField>
                </DetailGrid>
                <p className="text-xs text-muted-foreground">
                  Only the latest status is stored, not a full tracking history. Use &ldquo;Refresh tracking&rdquo; under Actions below for the current position.
                </p>
              </Section>

              <Separator />

              <Section title="Actions">
                <ShipmentActions shipment={toShipmentActionsShape(shipment)} />
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
