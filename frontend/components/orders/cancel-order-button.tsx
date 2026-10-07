"use client";

import { useId, useRef, useState } from "react";
import { Ban, CircleAlert, CircleCheck, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCancelOrderMutation, useRevertCancellationMutation } from "@/lib/api-client/mutations/orders.mutations";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import type { CancelOrderResult, OrderDetail, PaymentLinkCancelResult, ShopifyCancelResult } from "@/lib/api-client/types/orders.types";

// What has happened to the order's Cashfree link(s), read from the order's own payments (what the backend derives it
// from too), so it is right after a reload. "Payment link cancelled" is the failure reason the backend records when it
// cancels a link through Cashfree.
export function derivePaymentLinkState(order: OrderDetail): PaymentLinkCancelResult {
  const cashfree = order.payments.filter((p) => p.source === "CASHFREE");
  if (cashfree.some((p) => p.status === "PENDING" || p.status === "PROCESSING")) {
    return { status: order.status === "CANCELLED" ? "failed" : "none", reason: order.paymentLinkCancellation?.reason };
  }
  if (order.payments.some((p) => p.status === "SUCCESS")) return { status: "paid" };
  if (cashfree.some((p) => p.failureReason === "Payment link cancelled")) return { status: "cancelled" };
  return { status: "none" };
}

/** Cashfree-link outcome of a cancellation. Never says a paid order was refunded - it was not. */
export function PaymentLinkCancelNote({ link }: { link: PaymentLinkCancelResult }) {
  if (link.status === "cancelled") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
        <CircleCheck className="size-4" /> The Cashfree payment link was cancelled - the customer can no longer pay it.
      </p>
    );
  }
  if (link.status === "paid") return <p className="text-sm text-muted-foreground">Payment received. Cancelling this order does not automatically issue a refund.</p>;
  if (link.status === "failed") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>Order cancelled, but the Cashfree payment link could not be cancelled{link.reason ? `: ${link.reason}` : "."} The customer may still be able to pay it - retry the cancellation.</span>
      </p>
    );
  }
  return null;
}

/** What the last cancel attempt did to Shopify - shown on the order until the page is left, and used to offer a retry. */
export function ShopifyCancelNote({ shopify }: { shopify: ShopifyCancelResult }) {
  if (shopify.status === "cancelled") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
        <CircleCheck className="size-4" /> The linked Shopify order was cancelled.
      </p>
    );
  }
  if (shopify.status === "not_linked") return <p className="text-sm text-muted-foreground">This order was never sent to Shopify, so there was nothing to cancel there.</p>;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>The CRM order is cancelled, but Shopify could not be cancelled{shopify.reason ? `: ${shopify.reason}` : "."} You can retry the Shopify cancellation.</span>
    </p>
  );
}

// Cancel/Revert. Never deletes the order - the backend only changes its status (and tries Shopify). A successful
// payment is NOT refunded by this, which the confirmation says plainly.
/** Payment state at a glance on the order page: what was paid how, the link's state, and that a cancel never refunds. */
export function OrderPaymentSummary({ order }: { order: OrderDetail }) {
  const cashfree = order.payments.find((p) => p.source === "CASHFREE") ?? null;
  const cod = order.payments.find((p) => p.method === "COD") ?? null;
  const paid = order.payments.some((p) => p.status === "SUCCESS");
  const link = derivePaymentLinkState(order);
  const linkLabel = !cashfree
    ? null
    : cashfree.status === "SUCCESS"
      ? "Paid"
      : link.status === "cancelled"
        ? "Cancelled"
        : cashfree.status === "PENDING" || cashfree.status === "PROCESSING"
          ? order.status === "CANCELLED"
            ? "Still active - cancellation failed"
            : "Active"
          : /expired/i.test(cashfree.failureReason ?? "")
            ? "Expired - create a new link"
            : order.status === "CANCELLED"
              ? (cashfree.failureReason ?? "Closed")
              : "Could not be created - use \"Retry Cashfree payment link\"";
  const statusLabel = (status: string) => ({ SUCCESS: "Paid", PENDING: "Pending", PROCESSING: "Processing", FAILED: "Failed", REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Partially refunded" })[status] ?? status;

  // A prepaid order whose link was never created (Cashfree off / rejected): still worth explaining on the page.
  const prepaidNoLink = !cashfree && !cod && order.payments.length === 0 && order.status === "PENDING_PAYMENT";
  if (!cashfree && !cod && !prepaidNoLink) return null;
  const note = order.whatsappNotification;
  return (
    <dl className="grid gap-1 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-2" aria-label="Payment summary">
      <div>
        <dt className="text-xs text-muted-foreground">Payment</dt>
        <dd className="font-medium">{cashfree ? `Cashfree / ${statusLabel(cashfree.status)}` : cod ? `COD / ${cod.status === "SUCCESS" ? "Paid" : "Unpaid"}` : "Prepaid / Pending"}</dd>
      </div>
      {prepaidNoLink ? (
        <div>
          <dt className="text-xs text-muted-foreground">Payment link</dt>
          <dd className="font-medium">Not created - use &quot;Retry Cashfree payment link&quot; below</dd>
        </div>
      ) : null}
      {cashfree ? (
        <div>
          <dt className="text-xs text-muted-foreground">Payment link</dt>
          <dd className="font-medium">{linkLabel}</dd>
        </div>
      ) : null}
      {note ? (
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">WhatsApp notification</dt>
          <dd className="font-medium">
            {note.sent
              ? `Sent via ${note.provider ? (PROVIDER_LABELS[note.provider] ?? note.provider) : "WhatsApp"} (${note.via === "FREE_TEXT" ? "free text" : "approved template"})`
              : `Not sent${note.reason ? ` - ${note.reason}` : ""}`}
          </dd>
        </div>
      ) : null}
      {paid && order.status === "CANCELLED" ? (
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Refund</dt>
          <dd className="font-medium">Not automatically issued</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Restores a cancelled CRM order to the status recorded when it was cancelled. Confirms first; nothing changes on "Keep Cancelled". */
export function RevertCancellationButton({ order }: { order: Pick<OrderDetail, "id" | "orderNumber" | "externalNumber"> }) {
  const [open, setOpen] = useState(false);
  const revert = useRevertCancellationMutation();
  // Synchronous re-entry guard, same reason as CancelOrderButton: a fast double click fires before isPending re-renders.
  const inFlight = useRef(false);

  function run() {
    if (inFlight.current || revert.isPending) return;
    inFlight.current = true;
    revert.mutate(
      { orderId: order.id },
      {
        onSuccess: (result) => {
          setOpen(false);
          if (result.alreadyActive) toast.info(`Order ${order.orderNumber} is not cancelled.`);
          else toast.success(`Order ${order.orderNumber} cancellation reverted successfully.`);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not revert the cancellation.")),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} disabled={revert.isPending}>
        <Undo2 data-icon="inline-start" />
        Revert Cancellation
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Revert Cancellation?"
        description={
          <>
            <span className="mb-2 block text-base font-semibold text-foreground">{order.orderNumber}</span>
            This will restore the order from Cancelled status. Do you want to continue?
          </>
        }
        confirmLabel="Revert Order"
        dismissLabel="Keep Cancelled"
        pendingLabel="Reverting…"
        pending={revert.isPending}
        onConfirm={run}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>The order returns to the status it had before it was cancelled. Payments, shipments, amounts and customer details are not changed.</li>
          {order.externalNumber ? <li>A linked Shopify order that was cancelled stays cancelled in Shopify.</li> : null}
        </ul>
      </ConfirmActionDialog>
    </>
  );
}

type CancelTarget = Pick<OrderDetail, "id" | "orderNumber" | "externalNumber">;

function toastCancelResult(result: CancelOrderResult, orderNumber: string) {
  if (result.paymentLink.status === "failed") toast.warning("Order cancelled, but the Cashfree payment link could not be cancelled.");
  else if (result.shopify.status === "failed") toast.warning("Order cancelled in the CRM, but the Shopify cancellation failed.");
  else if (result.alreadyCancelled) toast.info("This order was already cancelled.");
  else toast.success(`Order ${orderNumber} cancelled successfully.`);
}

/** The "Cancel Order?" confirmation + cancel request, shared by Order Detail and the Orders list rows. Nothing is sent until "Cancel Order" is confirmed. */
export function CancelOrderDialog({ open, onOpenChange, order, hasPaid, hasOpenLink, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; order: CancelTarget; hasPaid: boolean; hasOpenLink: boolean; onDone?: (result: CancelOrderResult) => void }) {
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const cancel = useCancelOrderMutation();
  // Synchronous re-entry guard: a fast double click fires twice before `isPending` re-renders (this produced two
  // concurrent cancels - two Shopify attempts - when tried in a real browser).
  const inFlight = useRef(false);
  const shopifyLinked = Boolean(order.externalNumber);

  function run() {
    if (inFlight.current || cancel.isPending) return;
    inFlight.current = true;
    cancel.mutate(
      { orderId: order.id, reason: reason.trim() || undefined },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          setReason("");
          onDone?.(result);
          toastCancelResult(result, order.orderNumber);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not cancel the order.")),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }

  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel Order?"
      description={
        <>
          <span className="mb-2 block text-base font-semibold text-foreground">{order.orderNumber}</span>
          Are you sure you want to cancel this order? You can revert this action later.
        </>
      }
      confirmLabel="Cancel Order"
      dismissLabel="Keep Order"
      pendingLabel="Cancelling…"
      pending={cancel.isPending}
      destructive
      onConfirm={run}
    >
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>The CRM order is only marked Cancelled - it is never deleted, and its previous status is remembered so it can be restored.</li>
        <li>{shopifyLinked ? "The linked Shopify order will also be cancelled. Shopify cannot un-cancel an order, so reverting restores the CRM order only." : "This order is not linked to Shopify, so only the CRM order changes."}</li>
        {hasOpenLink ? <li>Any unpaid Cashfree payment link on this order will be cancelled so the customer can&apos;t pay for a cancelled order. Reverting does not reopen it.</li> : null}
        <li>{hasPaid ? "Payment received. Cancelling this order does not automatically issue a refund - refund it separately if needed." : "Successful payments are never refunded automatically by cancelling."}</li>
      </ul>
      <div className="grid gap-1.5">
        <Label htmlFor={reasonId}>Reason (optional)</Label>
        <Input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Created by mistake" />
      </div>
    </ConfirmActionDialog>
  );
}

export function CancelOrderButton({ order }: { order: OrderDetail }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<CancelOrderResult | null>(null);
  const cancel = useCancelOrderMutation();
  // Synchronous re-entry guard: a fast double click fires twice before `isPending` re-renders (this produced two
  // concurrent cancels - two Shopify attempts - when tried in a real browser).
  const inFlight = useRef(false);

  const isCancelled = order.status === "CANCELLED";
  // After a CRM-side cancel, the only thing left to do is retry a Shopify cancellation that failed.
  // The persisted outcome (survives a reload) is the source of truth; `last` only makes it instant right after a click.
  const shopifyState = last?.shopify ?? order.shopifyCancellation;
  const canRetryShopify = isCancelled && shopifyState?.status === "failed" && Boolean(order.externalNumber);
  // Same idea for Cashfree: an unpaid link still open on a cancelled order is exactly what is left to retry.
  const linkState = last?.paymentLink ?? derivePaymentLinkState(order);
  const canRetryLink = isCancelled && derivePaymentLinkState(order).status === "failed";
  const canRetry = canRetryShopify || canRetryLink;
  const retryLabel = canRetryShopify && canRetryLink ? "Retry cancellation" : canRetryLink ? "Retry Cashfree link cancellation" : "Retry Shopify cancellation";
  const hasPaid = Number(order.paidAmount) > 0;
  const hasOpenLink = order.payments.some((p) => p.source === "CASHFREE" && (p.status === "PENDING" || p.status === "PROCESSING"));

  if (isCancelled && !canRetry) {
    return (
      <div className="flex flex-col items-end gap-2">
        {shopifyState ? <ShopifyCancelNote shopify={shopifyState} /> : null}
        <PaymentLinkCancelNote link={linkState} />
        <RevertCancellationButton order={order} />
      </div>
    );
  }

  // Retry of a failed Shopify/Cashfree half on an already-cancelled order (no confirmation needed - it re-attempts what the
  // user already confirmed). The first-time cancel goes through CancelOrderDialog.
  function run() {
    if (inFlight.current || cancel.isPending) return;
    inFlight.current = true;
    cancel.mutate(
      { orderId: order.id },
      {
        onSuccess: (result) => {
          setLast(result);
          toastCancelResult(result, order.orderNumber);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not cancel the order.")),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {shopifyState ? <ShopifyCancelNote shopify={shopifyState} /> : null}
      {isCancelled ? <PaymentLinkCancelNote link={linkState} /> : null}
      {isCancelled ? <RevertCancellationButton order={order} /> : null}
      <Button type="button" variant={canRetry ? "outline" : "destructive"} size="sm" onClick={() => (canRetry ? run() : setOpen(true))} disabled={cancel.isPending}>
        <Ban data-icon="inline-start" />
        {canRetry ? (cancel.isPending ? "Retrying…" : retryLabel) : "Cancel Order"}
      </Button>

      <CancelOrderDialog open={open} onOpenChange={setOpen} order={order} hasPaid={hasPaid} hasOpenLink={hasOpenLink} onDone={setLast} />
    </div>
  );
}
