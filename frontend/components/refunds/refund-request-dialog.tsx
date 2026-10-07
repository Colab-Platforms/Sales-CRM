"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateRefundRequestMutation } from "@/lib/api-client/mutations/refunds.mutations";
import { formatMoney } from "@/lib/order-status";
import { APPROVAL_DISCLAIMER, REASON_MAX, validateRefundForm, type RefundFormErrors } from "@/lib/refund-status";
import type { RefundablePaymentView } from "@/lib/api-client/types/refunds.types";

export interface RefundFormValues {
  amount: string;
  reason: string;
}

/** The form itself (no dialog chrome), so it renders and tests on its own. */
export function RefundRequestForm({
  orderNumber,
  payment,
  values,
  errors,
  submitting,
  onChange,
  onSubmit,
  onCancel,
}: {
  orderNumber: string;
  payment: RefundablePaymentView;
  values: RefundFormValues;
  errors: RefundFormErrors;
  submitting?: boolean;
  onChange: (patch: Partial<RefundFormValues>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const money = (v: string) => formatMoney(v, payment.currency);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="grid gap-4"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 text-sm" data-testid="refund-balances">
        <dt className="text-muted-foreground">Order</dt>
        <dd className="text-right font-medium">{orderNumber}</dd>
        <dt className="text-muted-foreground">Payment amount</dt>
        <dd className="text-right tabular-nums">{money(payment.amount)}</dd>
        <dt className="text-muted-foreground">Already refunded</dt>
        <dd className="text-right tabular-nums">{money(payment.refundedAmount)}</dd>
        {Number(payment.reservedAmount) > 0 ? (
          <>
            <dt className="text-muted-foreground">Held by open requests</dt>
            <dd className="text-right tabular-nums">{money(payment.reservedAmount)}</dd>
          </>
        ) : null}
        <dt className="font-medium">Currently refundable</dt>
        <dd className="text-right font-semibold tabular-nums">{money(payment.refundableAmount)}</dd>
      </dl>

      <div className="grid gap-1.5">
        <label htmlFor="refund-amount" className="text-sm font-medium">
          Refund amount ({payment.currency})
        </label>
        <Input id="refund-amount" inputMode="decimal" placeholder="e.g. 250.00" value={values.amount} onChange={(e) => onChange({ amount: e.target.value })} aria-invalid={Boolean(errors.amount)} />
        {errors.amount ? (
          <p role="alert" className="text-xs text-destructive">
            {errors.amount}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="refund-reason" className="text-sm font-medium">
          Reason
        </label>
        <textarea
          id="refund-reason"
          rows={3}
          maxLength={REASON_MAX}
          placeholder="Why is this refund needed?"
          value={values.reason}
          onChange={(e) => onChange({ reason: e.target.value })}
          aria-invalid={Boolean(errors.reason)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {errors.reason ? (
          <p role="alert" className="text-xs text-destructive">
            {errors.reason}
          </p>
        ) : null}
      </div>

      <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs" data-testid="refund-approval-warning">
        This only submits a request. A manager or admin must approve it before a refund can be executed — no money is returned now. {APPROVAL_DISCLAIMER}
      </p>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit Refund Request"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RefundRequestDialog({ open, onOpenChange, orderId, orderNumber, payment }: { open: boolean; onOpenChange: (open: boolean) => void; orderId: string; orderNumber: string; payment: RefundablePaymentView }) {
  const [values, setValues] = useState<RefundFormValues>({ amount: "", reason: "" });
  const [errors, setErrors] = useState<RefundFormErrors>({});
  // One key per dialog opening: a double click or a retry after a slow response returns the SAME request instead of creating another.
  const submissionKey = useRef<string>(crypto.randomUUID());
  const create = useCreateRefundRequestMutation();

  function close(next: boolean) {
    if (!next) {
      if (create.isPending) return;
      setValues({ amount: "", reason: "" });
      setErrors({});
      create.reset();
      submissionKey.current = crypto.randomUUID();
    }
    onOpenChange(next);
  }

  function submit() {
    if (create.isPending) return;
    const found = validateRefundForm(values.amount, values.reason, payment.refundableAmount);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(
      { orderId, paymentId: payment.paymentId, amount: values.amount.trim(), reason: values.reason.trim(), submissionKey: submissionKey.current },
      {
        onSuccess: () => {
          toast.success("Refund request submitted for approval. No refund has been issued.");
          close(false);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not submit the refund request.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Request Refund</DialogTitle>
          <DialogDescription>Ask for part or all of this payment to be refunded to the customer.</DialogDescription>
        </DialogHeader>
        <RefundRequestForm orderNumber={orderNumber} payment={payment} values={values} errors={errors} submitting={create.isPending} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} onSubmit={submit} onCancel={() => close(false)} />
      </DialogContent>
    </Dialog>
  );
}
