"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CUSTOM_ITEM_DEFAULTS, CUSTOM_ITEM_MAX_QUANTITY, CUSTOM_ITEM_NAME_MAX, CUSTOM_WEIGHT_UNITS, customItemFlags, validateCustomItem, type CustomItemDraft, type CustomItemErrors, type CustomItemForm, type CustomWeightUnit } from "@/lib/custom-item";
import { formatMoney } from "@/lib/order-status";

/** "Add custom item": a free-form line that is not in the Shopify catalogue. Adding it only appends it to the unsaved order; nothing is created until the order is submitted. */
export function AddCustomItemDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; onAdd: (form: CustomItemForm) => void }) {
  const [form, setForm] = useState<CustomItemForm>(CUSTOM_ITEM_DEFAULTS);
  const [errors, setErrors] = useState<CustomItemErrors>({});
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<CustomItemForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (touched) setErrors(validateCustomItem(next));
  };

  function close() {
    setForm(CUSTOM_ITEM_DEFAULTS);
    setErrors({});
    setTouched(false);
    onOpenChange(false);
  }
  function submit() {
    const found = validateCustomItem(form);
    setTouched(true);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onAdd(form);
    close();
  }

  const field = "grid gap-1 text-xs font-medium";
  const err = (m?: string) => (m ? <span role="alert" className="text-xs font-normal text-destructive">{m}</span> : null);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-[460px]" data-testid="add-custom-item-dialog">
        <DialogHeader>
          <DialogTitle>Add custom item</DialogTitle>
          <DialogDescription>For an item that is not in the Shopify catalogue. It is added to this order only - no catalogue product is created.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className={field} htmlFor="custom-item-name">
            Item name *
            <Input id="custom-item-name" value={form.name} maxLength={CUSTOM_ITEM_NAME_MAX} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Gift wrapping" aria-invalid={Boolean(errors.name)} data-testid="custom-item-name" />
            {err(errors.name)}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={field} htmlFor="custom-item-price">
              Price (₹) *
              <Input id="custom-item-price" inputMode="decimal" value={form.price} onChange={(e) => set({ price: e.target.value })} placeholder="0.00" aria-invalid={Boolean(errors.price)} data-testid="custom-item-price" />
              {err(errors.price)}
            </label>
            <label className={field} htmlFor="custom-item-quantity">
              Quantity *
              <Input id="custom-item-quantity" inputMode="numeric" value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} placeholder={`1 - ${CUSTOM_ITEM_MAX_QUANTITY}`} aria-invalid={Boolean(errors.quantity)} data-testid="custom-item-quantity" />
              {err(errors.quantity)}
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={form.taxable} onChange={(e) => set({ taxable: e.target.checked })} data-testid="custom-item-taxable" />
            <span>
              Item is taxable
              <span className="block text-xs text-muted-foreground">Off by default: the CRM adds no tax of its own. Shopify applies tax only if your shop has tax rates set up.</span>
            </span>
          </label>
          {form.taxable ? (
            <p role="note" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="custom-item-tax-warning">
              Shopify may add tax to this item if your shop has tax rates set up. The CRM total does not include that tax, so the order may show as out of sync until it is reviewed in Shopify.
            </p>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={form.physical} onChange={(e) => set({ physical: e.target.checked })} data-testid="custom-item-physical" />
            <span>
              Item is a physical product
              <span className="block text-xs text-muted-foreground">On by default. Turn it off for a service - it then needs no shipping and no weight.</span>
            </span>
          </label>
          {form.physical ? (
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <label className={field} htmlFor="custom-item-weight">
                Item weight (optional)
                <Input id="custom-item-weight" inputMode="decimal" value={form.weight} onChange={(e) => set({ weight: e.target.value })} placeholder="e.g. 0.25" aria-invalid={Boolean(errors.weight)} data-testid="custom-item-weight" />
                {err(errors.weight)}
              </label>
              <label className={field} htmlFor="custom-item-weight-unit">
                Weight unit
                <select id="custom-item-weight-unit" className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={form.weightUnit} onChange={(e) => set({ weightUnit: e.target.value as CustomWeightUnit })} data-testid="custom-item-weight-unit">
                  {CUSTOM_WEIGHT_UNITS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} data-testid="custom-item-cancel">
            Cancel
          </Button>
          <Button type="button" onClick={submit} data-testid="custom-item-add">
            Add item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A custom line in the unsaved order: its name, flags, an editable price and quantity, the line total and Remove. */
export function CustomItemCard({ item, index, onChange, onRemove, canRemove, invalid }: { item: { key: string; quantity: string; unitPrice: string; custom: CustomItemDraft }; index: number; onChange: (patch: { quantity?: string; unitPrice?: string }) => void; onRemove: () => void; canRemove: boolean; invalid: boolean }) {
  const c = item.custom;
  const total = Math.max(Math.round(Number(item.unitPrice || 0) * 100) * (Number(item.quantity) || 0), 0);
  return (
    <div className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[1fr_auto]" data-testid="custom-item-card">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">Item {index + 1} · Custom item</p>
        <p className="break-words font-medium">{c.name}</p>
        <p className="text-xs text-muted-foreground">
          {customItemFlags({ taxable: c.taxable, requiresShipping: c.physical, weightGrams: c.physical && c.weight ? String(c.weightUnit === "KG" ? Number(c.weight) * 1000 : Number(c.weight)) : null })}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            Price ₹
            <Input value={item.unitPrice} inputMode="decimal" className="h-8 w-24" onChange={(e) => onChange({ unitPrice: e.target.value })} aria-label={`Price of ${c.name}`} aria-invalid={invalid} />
          </label>
          <label className="flex items-center gap-1">
            Qty
            <Input value={item.quantity} inputMode="numeric" className="h-8 w-20" onChange={(e) => onChange({ quantity: e.target.value })} aria-label={`Quantity of ${c.name}`} aria-invalid={invalid} />
          </label>
          <span className="tabular-nums">Line total {formatMoney((total / 100).toFixed(2))}</span>
        </div>
      </div>
      {canRemove ? (
        <Button type="button" variant="outline" size="sm" className="h-8 w-fit self-start" onClick={onRemove} data-testid="custom-item-remove">
          <Trash2 data-icon="inline-start" />
          Remove
        </Button>
      ) : null}
    </div>
  );
}
