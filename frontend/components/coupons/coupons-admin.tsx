"use client";

import { useState } from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/api-client/client";
import type { Coupon, CouponEligibility, CouponInput } from "@/lib/api-client/endpoints/coupons.api";
import { useCouponsQuery, useCreateCouponMutation, useDeleteCouponMutation, useSetCouponActiveMutation, useUpdateCouponMutation } from "@/hooks/useCoupons";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";

const ELIGIBILITY_LABEL: Record<CouponEligibility, string> = { ALL: "All customers", REGULAR: "Regular customers", DISTRIBUTOR: "Distributors only" };
const EMPTY: CouponInput = { code: "", discountType: "FIXED", discountValue: "", eligibility: "ALL", minOrderValue: null, maxDiscount: null, isActive: true };
const valueText = (c: Pick<Coupon, "discountType" | "discountValue">) => (c.discountType === "PERCENT" ? `${Number(c.discountValue)}%` : `₹${Number(c.discountValue)}`);

// Admin Panel -> Coupons. The backend validates everything again when an order uses a coupon; this screen only edits the list.
export function CouponsAdmin() {
  const role = useAuthStore((s) => s.user?.role);
  const list = useCouponsQuery(role === "ADMIN");
  const toggle = useSetCouponActiveMutation();
  const remove = useDeleteCouponMutation();
  const [editing, setEditing] = useState<{ id: string | null; input: CouponInput } | null>(null);

  if (role !== "ADMIN") return <p className="text-sm text-muted-foreground">Only an Admin can manage coupons.</p>;

  const onToggle = (c: Coupon) =>
    toggle.mutate({ id: c.id, isActive: !c.isActive }, { onSuccess: () => toast.success(`${c.code} is now ${c.isActive ? "inactive" : "active"}.`), onError: (e) => toast.error(getErrorMessage(e)) });
  const onDelete = (c: Coupon) => {
    const note = c.usedByOrders > 0 ? `${c.code} was used by ${c.usedByOrders} order(s). It will be removed from the list, and those orders keep their discount record.` : `Delete ${c.code}?`;
    if (!window.confirm(note)) return;
    remove.mutate(c.id, { onSuccess: () => toast.success(`${c.code} deleted.`), onError: (e) => toast.error(getErrorMessage(e)) });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Coupons" description="Admin Panel · coupons telecallers can apply in Edit Discount. One coupon per order; the server checks every one." />
      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing({ id: null, input: EMPTY })} data-testid="new-coupon">
          <Plus data-icon="inline-start" />
          New coupon
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <Skeleton className="m-4 h-24" />
          ) : list.isError ? (
            <p className="p-4 text-sm text-destructive">{getErrorMessage(list.error)}</p>
          ) : (list.data ?? []).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No coupons yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="coupons-table">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Code</th>
                    <th className="px-4 py-2">Discount</th>
                    <th className="px-4 py-2">Eligibility</th>
                    <th className="px-4 py-2">Min order</th>
                    <th className="px-4 py-2">Max discount</th>
                    <th className="px-4 py-2">Used</th>
                    <th className="px-4 py-2">Active</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data!.map((c) => (
                    <tr key={c.id} className="border-b last:border-0" data-testid={`coupon-row-${c.code}`}>
                      <td className="px-4 py-2 font-mono font-medium">{c.code}</td>
                      <td className="px-4 py-2">{valueText(c)} off{c.discountType === "FIXED" ? " (fixed)" : ""}</td>
                      <td className="px-4 py-2"><Badge variant="secondary">{ELIGIBILITY_LABEL[c.eligibility]}</Badge></td>
                      <td className="px-4 py-2 tabular-nums">{c.minOrderValue ? `₹${Number(c.minOrderValue)}` : "—"}</td>
                      <td className="px-4 py-2 tabular-nums">{c.maxDiscount ? `₹${Number(c.maxDiscount)}` : "—"}</td>
                      <td className="px-4 py-2 tabular-nums">{c.usedByOrders}</td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={c.isActive}
                          aria-label={`${c.code} active`}
                          disabled={toggle.isPending}
                          onClick={() => onToggle(c)}
                          data-testid={`coupon-toggle-${c.code}`}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${c.isActive ? "bg-primary" : "bg-muted"}`}
                        >
                          <span className={`inline-block size-5 rounded-full bg-background shadow transition-transform ${c.isActive ? "translate-x-5" : "translate-x-0.5"}`} />
                        </button>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button type="button" size="sm" variant="outline" onClick={() => setEditing({ id: c.id, input: { code: c.code, discountType: c.discountType, discountValue: c.discountValue, eligibility: c.eligibility, minOrderValue: c.minOrderValue, maxDiscount: c.maxDiscount, isActive: c.isActive } })} aria-label={`Edit ${c.code}`}>
                            <Pencil />
                          </Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => onDelete(c)} disabled={remove.isPending} aria-label={`Delete ${c.code}`}>
                            <Trash2 />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {editing ? <CouponDialog id={editing.id} initial={editing.input} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function CouponDialog({ id, initial, onClose }: { id: string | null; initial: CouponInput; onClose: () => void }) {
  const create = useCreateCouponMutation();
  const update = useUpdateCouponMutation();
  const [form, setForm] = useState<CouponInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;
  const set = <K extends keyof CouponInput>(k: K, v: CouponInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  function save() {
    setError(null);
    const input: CouponInput = { ...form, code: form.code.trim().toUpperCase(), discountValue: String(form.discountValue).trim(), minOrderValue: form.minOrderValue?.trim() || null, maxDiscount: form.discountType === "PERCENT" ? form.maxDiscount?.trim() || null : null };
    const done = { onSuccess: () => { toast.success(id ? "Coupon updated." : "Coupon created."); onClose(); }, onError: (e: unknown) => setError(getErrorMessage(e)) };
    if (id) update.mutate({ id, input }, done);
    else create.mutate(input, done);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{id ? "Edit coupon" : "New coupon"}</DialogTitle>
          <DialogDescription>Changing a coupon never changes orders that already used it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="coupon-code" className="text-xs">Coupon code</Label>
            <Input id="coupon-code" value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="e.g. DISTRIBUTOR500" autoComplete="off" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="coupon-type" className="text-xs">Discount type</Label>
              <NativeSelect id="coupon-type" value={form.discountType} onChange={(e) => set("discountType", e.target.value as CouponInput["discountType"])}>
                <option value="FIXED">Fixed amount (₹)</option>
                <option value="PERCENT">Percentage (%)</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="coupon-value" className="text-xs">Discount value</Label>
              <Input id="coupon-value" inputMode="decimal" value={form.discountValue} onChange={(e) => set("discountValue", e.target.value)} placeholder={form.discountType === "FIXED" ? "500" : "10"} autoComplete="off" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="coupon-eligibility" className="text-xs">Who can use it</Label>
            <NativeSelect id="coupon-eligibility" value={form.eligibility} onChange={(e) => set("eligibility", e.target.value as CouponEligibility)}>
              {(Object.keys(ELIGIBILITY_LABEL) as CouponEligibility[]).map((k) => <option key={k} value={k}>{ELIGIBILITY_LABEL[k]}</option>)}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="coupon-min" className="text-xs">Minimum order value (optional)</Label>
              <Input id="coupon-min" inputMode="decimal" value={form.minOrderValue ?? ""} onChange={(e) => set("minOrderValue", e.target.value)} placeholder="₹" autoComplete="off" />
            </div>
            {form.discountType === "PERCENT" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="coupon-max" className="text-xs">Maximum discount (optional)</Label>
                <Input id="coupon-max" inputMode="decimal" value={form.maxDiscount ?? ""} onChange={(e) => set("maxDiscount", e.target.value)} placeholder="₹" autoComplete="off" />
              </div>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => set("isActive", e.target.checked)} />
            Active
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={save} disabled={pending || !form.code.trim() || !String(form.discountValue).trim()}>{pending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
