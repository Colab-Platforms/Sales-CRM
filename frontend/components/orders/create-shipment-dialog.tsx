"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateShipmentMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { formatMoney } from "@/lib/order-status";

interface CreateShipmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  orderNumber: string;
  currency: string;
}

interface Field {
  key: "weight" | "length" | "breadth" | "height";
  label: string;
  unit: string;
  step: string;
}

const FIELDS: Field[] = [
  { key: "weight", label: "Weight", unit: "kg", step: "0.01" },
  { key: "length", label: "Length", unit: "cm", step: "0.5" },
  { key: "breadth", label: "Breadth", unit: "cm", step: "0.5" },
  { key: "height", label: "Height", unit: "cm", step: "0.5" },
];

// The backend words this error itself: it means a previous attempt got no reply, so the shipment may already exist in Shiprocket.
const UNCONFIRMED_HINT = /may already exist in Shiprocket/i;

export function CreateShipmentDialog({ open, onOpenChange, orderId, orderNumber, currency }: CreateShipmentDialogProps) {
  const [values, setValues] = useState({ weight: "", length: "", breadth: "", height: "" });
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const create = useCreateShipmentMutation();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setValues({ weight: "", length: "", breadth: "", height: "" });
      setNeedsConfirmation(false);
      setConfirmed(false);
      create.reset();
    }
    onOpenChange(next);
  }

  const numbers = { weight: Number(values.weight), length: Number(values.length), breadth: Number(values.breadth), height: Number(values.height) };
  const valid = Object.values(numbers).every((n) => Number.isFinite(n) && n > 0) && (!needsConfirmation || confirmed);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    create.mutate(
      { orderId, input: { ...numbers, ...(needsConfirmation ? { acknowledgeUnconfirmed: true } : {}) } },
      {
        onSuccess: (shipment) => {
          toast.success(
            shipment.paymentMethod === "COD" && shipment.collectOnDelivery
              ? `Shipment created. The courier will collect ${formatMoney(shipment.collectOnDelivery, currency)} on delivery.`
              : "Shipment created.",
          );
          handleOpenChange(false);
        },
        onError: (error) => {
          const message = getErrorMessage(error, "Could not create the shipment.");
          if (UNCONFIRMED_HINT.test(message)) setNeedsConfirmation(true);
          toast.error(message);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create Shiprocket shipment</DialogTitle>
            <DialogDescription>
              Order {orderNumber}. The address, items and payment come from the order; the parcel size and weight are not stored, so enter them here.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map((field) => (
              <div key={field.key} className="grid gap-1.5">
                <label htmlFor={`shipment-${field.key}`} className="text-sm font-medium">
                  {field.label} ({field.unit})
                </label>
                <Input
                  id={`shipment-${field.key}`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step={field.step}
                  value={values[field.key]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  required
                />
              </div>
            ))}
          </div>

          {needsConfirmation ? (
            <label className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I have checked the Shiprocket panel and this order has no shipment there, so create another.</span>
            </label>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? "Creating…" : "Create shipment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
