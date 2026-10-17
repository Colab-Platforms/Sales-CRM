"use client";

import { useState } from "react";
import { BadgeCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useMarkOrderPaidMutation } from "@/lib/api-client/mutations/orders.mutations";
import { useAuthStore } from "@/stores/auth-store";
import { canMarkPaid, markPaidMessage } from "@/lib/mark-paid";
import type { OrderDetail } from "@/lib/api-client/types/orders.types";

export function MarkPaidButton({ order }: { order: OrderDetail }) {
  const role = useAuthStore((s) => s.user?.role);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const mutation = useMarkOrderPaidMutation();
  if (!canMarkPaid(order, role)) return null;

  const submit = () => {
    mutation.mutate(
      { orderId: order.id, reason: reason.trim(), reference: reference.trim() || undefined },
      {
        onSuccess: (r) => {
          const m = markPaidMessage(r);
          (m.ok ? toast.success : toast.error)(m.text);
          setOpen(false);
          setReason("");
          setReference("");
        },
        onError: (e) => toast.error(getErrorMessage(e)),
      },
    );
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BadgeCheck className="mr-1.5 size-4" /> Mark as Paid
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Mark this order as paid"
        description="Only do this after you have checked that the money really arrived (for example on your own QR / bank app). It is recorded under your name as a payment verified outside Cashfree, and cannot be undone here."
        confirmLabel="Mark as Paid"
        pendingLabel="Recording..."
        dismissLabel="Cancel"
        pending={mutation.isPending}
        onConfirm={() => (reason.trim().length >= 3 ? submit() : toast.error("Say how the payment was verified"))}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mark-paid-reason">How was it verified? (required)</Label>
            <Input id="mark-paid-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. UPI success checked in bank app" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mark-paid-ref">UTR / transaction reference (optional)</Label>
            <Input id="mark-paid-ref" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
      </ConfirmActionDialog>
    </>
  );
}
