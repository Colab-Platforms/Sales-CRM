"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ExternalLink, Package, Printer, RefreshCw, Tag, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { useGenerateLabelMutation, useRefreshTrackingMutation, useSchedulePickupMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { integrationStatusQueryOptions } from "@/lib/api-client/queries/integrations.queries";
import type { ShipmentDetail } from "@/lib/api-client/types/orders.types";
import { useAuthStore } from "@/stores/auth-store";
import { AssignAwbDialog } from "./assign-awb-dialog";
import { CreateShipmentDialog } from "./create-shipment-dialog";

// Shipping is an operational step: the backend only allows admins and managers, so the actions are only offered to them.
function useCanShip() {
  const role = useAuthStore((s) => s.user?.role);
  const token = useAuthStore((s) => s.token);
  const status = useQuery({ ...integrationStatusQueryOptions(), enabled: Boolean(token) }).data;
  return { allowed: role === "ADMIN" || role === "MANAGER", configured: status?.shiprocket.configured ?? false };
}

const CLOSED_ORDER_STATUSES = new Set(["CANCELLED", "REFUNDED", "RETURNED"]);
const FINISHED_SHIPMENT_STATUSES = new Set(["DELIVERED", "RETURNED", "CANCELLED"]);

/** A shipment the CRM created in Shiprocket that is still live (not delivered, returned or cancelled). */
export function isLiveDirectShipment(shipment: ShipmentDetail): boolean {
  return shipment.source === "SHIPROCKET" && !FINISHED_SHIPMENT_STATUSES.has(shipment.status);
}

/** "Create Shiprocket shipment" - only offered when Shiprocket is set up, the caller may ship, and the order has no live direct shipment. */
export function CreateShipmentButton({ orderId, orderNumber, orderStatus, currency, shipments }: { orderId: string; orderNumber: string; orderStatus: string; currency: string; shipments: ShipmentDetail[] }) {
  const { allowed, configured } = useCanShip();
  const [open, setOpen] = useState(false);

  if (!allowed || !configured || CLOSED_ORDER_STATUSES.has(orderStatus) || shipments.some(isLiveDirectShipment)) return null;

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Package data-icon="inline-start" />
        Create Shiprocket shipment
      </Button>
      <CreateShipmentDialog open={open} onOpenChange={setOpen} orderId={orderId} orderNumber={orderNumber} currency={currency} />
    </>
  );
}

/** The next steps for one shipment the CRM created in Shiprocket, in the order they can be done. */
export function ShipmentActions({ shipment }: { shipment: ShipmentDetail }) {
  const { allowed, configured } = useCanShip();
  const [assignOpen, setAssignOpen] = useState(false);
  const pickup = useSchedulePickupMutation();
  const label = useGenerateLabelMutation();
  const tracking = useRefreshTrackingMutation();

  if (shipment.source !== "SHIPROCKET") return null;
  const done = FINISHED_SHIPMENT_STATUSES.has(shipment.status);
  const fail = (fallback: string) => (error: unknown) => toast.error(getErrorMessage(error, fallback));

  return (
    <div className="space-y-2">
      {shipment.labelUrl ? (
        <a href={shipment.labelUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <Printer className="size-3.5" />
          Open shipping label
          <ExternalLink className="size-3" />
        </a>
      ) : null}

      {allowed && configured && !done ? (
        <div className="flex flex-wrap gap-2">
          {shipment.status === "CREATED" ? (
            <>
              <Button type="button" size="sm" onClick={() => setAssignOpen(true)}>
                <Truck data-icon="inline-start" />
                Assign courier &amp; AWB
              </Button>
              <AssignAwbDialog open={assignOpen} onOpenChange={setAssignOpen} shipmentId={shipment.id} />
            </>
          ) : null}
          {shipment.status === "AWB_ASSIGNED" ? (
            <Button
              type="button"
              size="sm"
              disabled={pickup.isPending}
              onClick={() => pickup.mutate(shipment.id, { onSuccess: () => toast.success("Pickup scheduled."), onError: fail("Could not schedule the pickup.") })}
            >
              <CalendarClock data-icon="inline-start" />
              {pickup.isPending ? "Scheduling…" : "Schedule pickup"}
            </Button>
          ) : null}
          {shipment.trackingNumber && !shipment.labelUrl ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={label.isPending}
              onClick={() => label.mutate(shipment.id, { onSuccess: () => toast.success("Label generated."), onError: fail("Could not generate the label.") })}
            >
              <Tag data-icon="inline-start" />
              {label.isPending ? "Generating…" : "Generate label"}
            </Button>
          ) : null}
          {shipment.trackingNumber ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={tracking.isPending}
              onClick={() => tracking.mutate(shipment.id, { onSuccess: () => toast.success("Tracking refreshed."), onError: fail("Could not read tracking from Shiprocket.") })}
            >
              <RefreshCw data-icon="inline-start" />
              {tracking.isPending ? "Checking…" : "Refresh tracking"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
