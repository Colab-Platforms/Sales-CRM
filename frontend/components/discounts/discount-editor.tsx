"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatMoney } from "@/lib/order-status";
import { choiceCents, choiceFromCoupon, previewDiscount, type DiscountChoice, type DiscountOptions, type DiscountType } from "@/lib/discount";

const CUSTOM = "CUSTOM";
const COUPON = "COUPON";
const NONE = "NONE";
const cents = (n: number) => (n / 100).toFixed(2);

interface EditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: DiscountChoice;
  /** Live Fastrr coupons (or why they are unavailable). The CRM has no coupons of its own. */
  fastrr: DiscountOptions["fastrr"];
  /** The amount the discount applies to (subtotal, or the COD amount for a Prepaid Upgrade). */
  baseCents: number;
  currency?: string;
  /** Prepaid Upgrade: the discount must leave something to pay. */
  strict?: boolean;
  title?: string;
  onApply: (choice: DiscountChoice) => void;
}

function selectedKey(c: DiscountChoice): string {
  return c.mode;
}

// "Edit Discount": enter a Custom Discount (Fixed ₹ or Percentage %), pick a live Fastrr coupon, or remove it. The picked value
// REPLACES the current one (the default is never added to it). Only the choice is applied; the server decides the real amount.
export function EditorBody({ onOpenChange, current, fastrr, baseCents, currency = "INR", strict, onApply }: Omit<EditorProps, "open" | "title">) {
  const [key, setKey] = useState<string>(selectedKey(current));
  const [couponCode, setCouponCode] = useState(current.mode === "COUPON" ? current.code : "");
  const [type, setType] = useState<DiscountType>(current.mode === "CUSTOM" ? current.type : "FIXED");
  const [value, setValue] = useState(current.mode === "CUSTOM" ? current.value : "");

  const coupon = fastrr.coupons.find((c) => c.code === couponCode);
  const choice: DiscountChoice | null = key === NONE ? { mode: "NONE" } : key === CUSTOM ? { mode: "CUSTOM", type, value } : coupon ? choiceFromCoupon(coupon) : null;
  const minOrder = key === COUPON && coupon?.minCartTotal != null && baseCents < Math.round(coupon.minCartTotal * 100) ? `This coupon needs a minimum order of ${formatMoney(String(coupon.minCartTotal), currency)}` : null;
  const preview: ReturnType<typeof previewDiscount> =
    key === CUSTOM ? previewDiscount(baseCents, type, value, strict) : key === NONE ? { ok: true, cents: 0 } : !coupon ? { ok: false, error: null } : minOrder ? { ok: false, error: minOrder } : previewDiscount(baseCents, coupon.type, coupon.value, strict);
  const valid = preview.ok;
  const discountCents = preview.ok ? preview.cents : 0;
  const currentCents = choiceCents(baseCents, current, strict);

  return (
    <>
      <dl className="grid gap-1 rounded-lg border bg-muted/40 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Current Discount</dt>
          <dd className="font-medium tabular-nums">{formatMoney(cents(currentCents), currency)}</dd>
        </div>
      </dl>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="discount-kind" className="text-xs">Discount / Coupon</Label>
          <NativeSelect id="discount-kind" value={key} onChange={(e) => setKey(e.target.value)}>
            <option value={CUSTOM}>Custom Discount</option>
            <option value={COUPON}>Coupon Code</option>
            <option value={NONE}>No discount</option>
          </NativeSelect>
        </div>

        {key === COUPON ? (
          <div className="grid gap-1.5">
            <Label htmlFor="discount-fastrr" className="text-xs">Coupon Code</Label>
            {fastrr.available && fastrr.coupons.length > 0 ? (
              <NativeSelect id="discount-fastrr" value={couponCode} onChange={(e) => setCouponCode(e.target.value)}>
                <option value="">Select Fastrr Coupon</option>
                {fastrr.coupons.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.type === "PERCENT" ? `${Number(c.value)}% off` : `₹${Number(c.value)} off`}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <p role="status" className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {fastrr.available ? "No active Fastrr coupons right now." : `Fastrr coupons unavailable${fastrr.reason ? ` — ${fastrr.reason}` : ""}.`} You can still use a Custom Discount.
              </p>
            )}
            {minOrder ? <p role="alert" className="text-xs text-destructive">{minOrder}</p> : null}
          </div>
        ) : null}

        {key === CUSTOM ? (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">Discount Type</span>
              <div role="radiogroup" aria-label="Discount type" className="flex gap-2">
                {([["FIXED", "Fixed ₹"], ["PERCENT", "Percentage %"]] as const).map(([t, label]) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={type === t}
                    onClick={() => setType(t)}
                    className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${type === t ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="discount-value" className="text-xs">Discount Amount</Label>
              <div className="flex h-9 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring/50" aria-invalid={!preview.ok && preview.error ? true : undefined}>
                <span className="flex items-center border-r bg-muted px-3 text-sm text-muted-foreground" aria-hidden>{type === "FIXED" ? "₹" : "%"}</span>
                <Input id="discount-value" inputMode="decimal" autoComplete="off" placeholder={type === "FIXED" ? "e.g. 100" : "e.g. 10"} value={value} onChange={(e) => setValue(e.target.value)} className="h-full rounded-none border-0 shadow-none focus-visible:ring-0" aria-invalid={!preview.ok && preview.error ? true : undefined} />
              </div>
              {!preview.ok && preview.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {preview.error}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <dl className="grid gap-1.5 rounded-lg border p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="tabular-nums">{formatMoney(cents(baseCents), currency)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">New discount</dt>
          <dd className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">{valid ? `−${formatMoney(cents(discountCents), currency)}` : "—"}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t pt-1.5 text-base font-semibold">
          <dt>After discount</dt>
          <dd className="tabular-nums">{valid ? formatMoney(cents(baseCents - discountCents), currency) : "—"}</dd>
        </div>
      </dl>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button
          type="button"
          disabled={!valid || !choice}
          onClick={() => {
            if (choice && valid) {
              onApply(choice);
              onOpenChange(false);
            }
          }}
        >
          Apply
        </Button>
      </DialogFooter>
    </>
  );
}

export function DiscountEditor(props: EditorProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{props.title ?? "Edit Discount"}</DialogTitle>
          <DialogDescription>The discount you pick replaces the current one - they are never added together.</DialogDescription>
        </DialogHeader>
        {/* remounted on every open, so it always starts from the current discount */}
        {props.open ? <EditorBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}
