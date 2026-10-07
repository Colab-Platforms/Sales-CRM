"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ServiceabilityLine } from "@/components/whatsapp/inbox/courier-rates";
import { useCourierRates } from "@/hooks/useCourierRates";
import { shippingChargeState } from "@/lib/shipping-charge";
import { isDimensionDraftEmpty, dimensionsHint, parseParcelDimensions, productDimensionsNote, rateInputsOrMissing, resolvePackedDimensions, suggestPackedDimensions, type DimensionDraft, type UnitDimensionsCm } from "@/lib/package-dimensions";
import { WEIGHT_REQUIRED, estimateProductWeight, parseParcelWeight, shipmentDialogWeight, weightHint } from "@/lib/parcel-weight";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateShipmentMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { formatMoney } from "@/lib/order-status";

interface CreateShipmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  orderNumber: string;
  currency: string;
  /** The parcel weight already recorded on the order (Create Order). Prefills the field; the person can change it. Null = none recorded. */
  parcelWeightKg?: string | null;
  /** The order's lines with their RECORDED catalog unit weights - only used to suggest a parcel weight when the order has none recorded. */
  items?: { quantity: number; unitWeightKg?: string | null; unitDimensionsCm?: UnitDimensionsCm | null }[];
  /** Goods value of the order in INR (subtotal after discount) - the declared value for the rate request. */
  orderValue?: number;
  /** Delivery pincode and payment mode of the order, for the courier availability check. */
  pincode?: string | null;
  cod?: boolean;
}

// The backend words this error itself: it means a previous attempt got no reply, so the shipment may already exist in Shiprocket.
const UNCONFIRMED_HINT = /may already exist in Shiprocket/i;

export function CreateShipmentDialog({ open, onOpenChange, orderId, orderNumber, currency, parcelWeightKg, items, orderValue, pincode, cod }: CreateShipmentDialogProps) {
  // What the person TYPED (null = untouched, so a suggestion / the recorded value applies). A typed value is never overwritten.
  const [values, setValues] = useState<{ weight: string | null; dims: DimensionDraft | null }>({ weight: null, dims: null });
  // The courier whose Shiprocket rate is shown as selected - valid only for the rate request it was picked from.
  const [courierPick, setCourierPick] = useState<{ rateKey: string; courier: string } | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const create = useCreateShipmentMutation();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setValues({ weight: null, dims: null });
      setNeedsConfirmation(false);
      setConfirmed(false);
      create.reset();
    }
    onOpenChange(next);
  }

  // ONE weight field: what is typed (else the weight recorded on the order) is used for the courier availability check AND for creating the shipment.
  // Priority: what was typed > the weight already recorded on the order (authoritative, never overwritten) > a suggestion from complete product weights.
  const estimate = estimateProductWeight((items ?? []).map((i) => ({ unitKg: i.unitWeightKg ? Number(i.unitWeightKg) : null, quantity: i.quantity })));
  const recorded = parcelWeightKg ?? null;
  const resolvedWeight = shipmentDialogWeight(values.weight, recorded, estimate);
  const weightText = resolvedWeight.text;
  const hint = resolvedWeight.source === "recorded" ? "Recorded on the order. Adjust if the packed parcel weighs something else." : weightHint(resolvedWeight.source, estimate);
  const parcel = parseParcelWeight(weightText);
  // Packed parcel dimensions: suggested only for one unit of one product; otherwise entered by the person. Never added up across products.
  const dimensionLines = (items ?? []).map((i) => ({ unit: i.unitDimensionsCm ?? null, quantity: i.quantity }));
  const dimsResolved = resolvePackedDimensions(values.dims, suggestPackedDimensions(dimensionLines));
  const parcelDims = parseParcelDimensions(dimsResolved.draft);
  const numbers = parcel.ok && parcelDims.ok ? { weight: parcel.kg, length: parcelDims.cm.length, breadth: parcelDims.cm.breadth, height: parcelDims.cm.height } : null;

  // Shiprocket's rates for exactly this parcel, requested automatically (debounced) and again after any change. The CRM calculates nothing.
  const pincodeValid = /^[1-9]\d{5}$/.test(pincode ?? "");
  const rateRequest = rateInputsOrMissing({ pincodeValid, pincode: pincode ?? "", cod: Boolean(cod), weight: parcel.ok ? { ok: true, kg: parcel.kg } : { ok: false }, dims: parcelDims, dimsEmpty: isDimensionDraftEmpty(dimsResolved.draft), value: orderValue ?? 0 });
  const rates = useCourierRates(rateRequest.ok ? rateRequest.inputs : null, open);
  const pickKey = courierPick && courierPick.rateKey === rates.key ? courierPick.courier : null;
  // Any change to the rate inputs ends the previous pick: the default (cheapest) applies again to the new rates.
  if (courierPick && courierPick.rateKey !== rates.key) setCourierPick(null);
  const chosen = shippingChargeState({ requested: rateRequest.ok, calculating: rates.calculating, failed: rates.failed, result: rates.result, pickKey });
  // Never create a shipment while the rates for the current package are still being (re)calculated: they would describe an older package.
  const valid = numbers !== null && !rates.calculating && (!needsConfirmation || confirmed);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || !numbers) return;
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
      <DialogContent className="sm:max-w-[560px]">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create Shiprocket shipment</DialogTitle>
            <DialogDescription>
              Order {orderNumber}. The address, items and payment come from the order. Enter the packed parcel weight and size; the weight you enter here is the one used to check couriers and to create the shipment.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5" data-testid="parcel-details">
            <p className="text-sm font-semibold">Parcel Details</p>
            <label htmlFor="shipment-weight" className="text-sm font-medium">
              Parcel Weight (kg)
            </label>
            <Input id="shipment-weight" type="number" inputMode="decimal" min="0" step="0.01" placeholder="e.g. 0.5" value={weightText} onChange={(e) => setValues((prev) => ({ ...prev, weight: e.target.value }))} required aria-invalid={!parcel.ok && Boolean(parcel.error)} />
            <p className="text-xs text-muted-foreground" data-testid="weight-hint">{hint}</p>
            {!parcel.ok ? (
              <p role="alert" className="text-xs text-destructive">
                {parcel.error ?? WEIGHT_REQUIRED}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5" data-testid="parcel-dimensions">
            <p className="text-sm font-medium">Final packed parcel dimensions (cm)</p>
            <div className="grid grid-cols-3 gap-3">
              {(["length", "breadth", "height"] as const).map((side) => (
                <div key={side} className="grid gap-1.5">
                  <label htmlFor={`shipment-${side}`} className="text-xs text-muted-foreground">
                    {side === "length" ? "Length" : side === "breadth" ? "Breadth" : "Height"}
                  </label>
                  <Input id={`shipment-${side}`} type="number" inputMode="decimal" min="0" step="0.5" value={dimsResolved.draft[side]} onChange={(e) => setValues((prev) => ({ ...prev, dims: { ...dimsResolved.draft, [side]: e.target.value } }))} required />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="dimensions-hint">{dimensionsHint(dimsResolved.source, dimensionLines)}</p>
            {productDimensionsNote(dimensionLines) ? <p className="text-xs text-muted-foreground">Product dimensions: {productDimensionsNote(dimensionLines)} (per unit - not the packed parcel)</p> : null}
            {!parcelDims.ok && parcelDims.error ? <p role="alert" className="text-xs text-destructive">{parcelDims.error}</p> : null}
          </div>

          {pincode ? (
            <div data-testid="shipment-rates">
              <ServiceabilityLine
                pincodeState={pincodeValid ? "valid" : "invalid"}
                missing={rateRequest.ok || rateRequest.missing === "pincode" ? null : rateRequest.missing}
                calculating={rates.calculating}
                failed={rates.failed}
                result={rates.result}
                parcelWeightKg={parcel.ok ? parcel.kg : undefined}
                dimensions={parcelDims.ok ? parcelDims.cm : undefined}
                onRefresh={rates.refresh}
                selectedKey={chosen.kind === "rate" ? `${chosen.courier ?? "courier"}|${chosen.amount}` : null}
                onSelect={(key) => rates.key && setCourierPick({ rateKey: rates.key, courier: key })}
              />
              {chosen.kind === "rate" ? (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="selected-rate">
                  Selected: {chosen.courier ?? "courier"} — Shiprocket charge ₹{chosen.amount}. The courier is assigned after the shipment is created.
                </p>
              ) : null}
            </div>
          ) : null}

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
              {create.isPending ? "Creating…" : rates.calculating ? "Calculating rates…" : "Create shipment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
