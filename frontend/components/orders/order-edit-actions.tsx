"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { MapPin, Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { ordersApi } from "@/lib/api-client/endpoints/orders.api";
import { ordersKeys } from "@/lib/api-client/queries/orders.queries";
import { useChangeFlavourMutation, useUpdateShippingAddressMutation } from "@/lib/api-client/mutations/orders.mutations";
import type { OrderDetail, UpdateShippingAddressInput } from "@/lib/api-client/types/orders.types";
import { useAuthStore } from "@/stores/auth-store";
import { addressDraft, validateAddressDraft } from "./order-edit-form";

// Order page actions for an EXISTING order: switch a line's flavour and edit the delivery address. Admin, Manager and Telecaller only; the server enforces who may edit which order, whether the order is still open
// (no shipment, not fulfilled / cancelled in Shopify) and that a flavour change never alters the price - the buttons only explain what the server says.

const EDIT_ROLES = ["ADMIN", "MANAGER", "SALESPERSON"];

export function ChangeFlavourButton({ order }: { order: Pick<OrderDetail, "id" | "orderNumber"> }) {
  const role = useAuthStore((s) => s.user?.role);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const mutation = useChangeFlavourMutation();
  const listing = useQuery({ queryKey: [...ordersKeys.detail(order.id), "flavours"], queryFn: () => ordersApi.flavours(order.id), enabled: open });
  if (!role || !EDIT_ROLES.includes(role)) return null;

  const apply = async (itemId: string) => {
    const variantId = choice[itemId];
    if (!variantId || mutation.isPending) return;
    try {
      const r = await mutation.mutateAsync({ orderId: order.id, itemId, variantId });
      toast.success(r.message);
      setOpen(false);
    } catch (e) {
      toast.error(getErrorMessage(e, "The flavour could not be changed."));
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="change-flavour">
        <Shuffle className="size-4" /> Change flavour
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change flavour - {order.orderNumber}</DialogTitle>
            <DialogDescription>Switch a line to another flavour of the same product at the same price. The order total does not change; Shopify is updated too.</DialogDescription>
          </DialogHeader>
          {listing.isLoading ? <p className="text-sm text-muted-foreground">Loading flavours…</p> : null}
          {listing.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(listing.error, "Could not load the flavours.")}</p> : null}
          {listing.data && !listing.data.editable ? <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-sm text-amber-700" data-testid="flavour-blocked">{listing.data.reason}</p> : null}
          {listing.data && listing.data.lines.length === 0 ? <p className="text-sm text-muted-foreground">This order has no catalogue product with flavours.</p> : null}
          {listing.data?.lines.map((line) => (
            <div key={line.itemId} className="space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">{line.productName} x {line.quantity}</div>
              <div className="text-xs text-muted-foreground">Now: {line.currentVariantName ?? "-"} - {line.unitPrice} each</div>
              <Label htmlFor={`flavour-${line.itemId}`}>New flavour</Label>
              <NativeSelect id={`flavour-${line.itemId}`} value={choice[line.itemId] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [line.itemId]: e.target.value }))} disabled={!listing.data?.editable}>
                <option value="">Choose a flavour…</option>
                {line.options.filter((o) => !o.current).map((o) => (
                  <option key={o.variantId} value={o.variantId} disabled={!o.priceMatches || !o.linkedToShopify}>
                    {o.name}{!o.priceMatches ? " (different price - not allowed)" : !o.linkedToShopify ? " (not linked to Shopify)" : ""}
                  </option>
                ))}
              </NativeSelect>
              <Button type="button" size="sm" onClick={() => void apply(line.itemId)} disabled={!listing.data?.editable || !choice[line.itemId] || mutation.isPending} data-testid="apply-flavour">
                {mutation.isPending ? "Updating…" : "Change flavour"}
              </Button>
            </div>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function EditAddressButton({ order }: { order: Pick<OrderDetail, "id" | "orderNumber" | "shippingAddress" | "shippingPincode"> }) {
  const role = useAuthStore((s) => s.user?.role);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<UpdateShippingAddressInput>(() => addressDraft(order));
  const mutation = useUpdateShippingAddressMutation();
  if (!role || !EDIT_ROLES.includes(role)) return null;

  const problem = validateAddressDraft(draft);
  const set = (key: keyof UpdateShippingAddressInput) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const save = async () => {
    if (problem || mutation.isPending) return;
    // blank optional fields are left out, so they never overwrite a stored value with an empty one
    const body = Object.fromEntries(Object.entries(draft).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as UpdateShippingAddressInput;
    try {
      const r = await mutation.mutateAsync({ orderId: order.id, ...body });
      toast.success(r.message);
      setOpen(false);
    } catch (e) {
      toast.error(getErrorMessage(e, "The address could not be changed."));
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(addressDraft(order)); setOpen(true); }} data-testid="edit-address">
        <MapPin className="size-4" /> Edit address
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delivery address - {order.orderNumber}</DialogTitle>
            <DialogDescription>Updates the CRM and the Shopify shipping address. Not possible once a shipment exists or Shopify has fulfilled the order.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {([["name", "Recipient name"], ["phone", "Phone"], ["line1", "House / Flat / Building No. and street"], ["line2", "Area / Landmark"], ["city", "City"], ["state", "State"], ["pincode", "Pincode"]] as const).map(([key, label]) => (
              <div key={key} className="grid gap-1">
                <Label htmlFor={`addr-${key}`}>{label}</Label>
                <Input id={`addr-${key}`} value={draft[key] ?? ""} onChange={set(key)} />
              </div>
            ))}
            {problem ? <p role="alert" className="text-sm text-destructive" data-testid="address-problem">{problem}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" onClick={() => void save()} disabled={Boolean(problem) || mutation.isPending} data-testid="save-address">{mutation.isPending ? "Saving…" : "Save address"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
