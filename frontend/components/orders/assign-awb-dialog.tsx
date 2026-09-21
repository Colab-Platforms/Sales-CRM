"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAssignAwbMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { couriersQueryOptions } from "@/lib/api-client/queries/integrations.queries";
import { formatMoney } from "@/lib/order-status";

interface AssignAwbDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipmentId: string;
}

export function AssignAwbDialog({ open, onOpenChange, shipmentId }: AssignAwbDialogProps) {
  const [courierId, setCourierId] = useState("");
  const couriers = useQuery({ ...couriersQueryOptions(shipmentId), enabled: open });
  const assign = useAssignAwbMutation();

  function handleOpenChange(next: boolean) {
    if (!next) setCourierId("");
    onOpenChange(next);
  }

  function handleAssign() {
    assign.mutate(
      { shipmentId, courierId: Number(courierId) },
      {
        onSuccess: (shipment) => {
          toast.success(shipment.awb ? `AWB ${shipment.awb} assigned.` : "AWB assigned.");
          handleOpenChange(false);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not assign an AWB.")),
      },
    );
  }

  const list = couriers.data ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Assign courier and AWB</DialogTitle>
          <DialogDescription>Couriers that can carry this shipment right now, as reported by Shiprocket.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5 py-2">
          <label htmlFor="awb-courier" className="text-sm font-medium">
            Courier
          </label>
          {couriers.isPending ? (
            <p className="text-sm text-muted-foreground">Checking couriers…</p>
          ) : couriers.isError ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {getErrorMessage(couriers.error, "Could not load couriers.")}
            </p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">Shiprocket reports no courier for this shipment.</p>
          ) : (
            <NativeSelect id="awb-courier" value={courierId} onChange={(e) => setCourierId(e.target.value)}>
              <option value="">Select a courier</option>
              {list.map((c) => (
                <option key={c.courierId} value={c.courierId}>
                  {[c.name, c.rate !== null ? formatMoney(String(c.rate)) : null, c.estimatedDays ? `${c.estimatedDays} days` : c.etd].filter(Boolean).join(" · ")}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleAssign} disabled={!courierId || assign.isPending}>
            {assign.isPending ? "Assigning…" : "Assign AWB"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
