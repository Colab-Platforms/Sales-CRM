"use client";

import { useRef, useState } from "react";
import { Ban, CircleAlert, CircleCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCancelOrderMutation } from "@/lib/api-client/mutations/orders.mutations";
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

export function CancelOrderButton({ order }: { order: OrderDetail }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [last, setLast] = useState<CancelOrderResult | null>(null);
  const cancel = useCancelOrderMutation();
  // Synchronous re-entry guard: a fast double click fires twice before `isPending` re-renders (this produced two
  // concurrent cancels - two Shopify attempts - when tried in a real browser).
  const inFlight = useRef(false);

  const isCancelled = order.status === "CANCELLED";
  const shopifyLinked = Boolean(order.externalNumber);
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
      <div className="flex flex-col items-end gap-1">
        {shopifyState ? <ShopifyCancelNote shopify={shopifyState} /> : null}
        <PaymentLinkCancelNote link={linkState} />
      </div>
    );
  }

  function run() {
    if (inFlight.current || cancel.isPending) return;
    inFlight.current = true;
    cancel.mutate(
      { orderId: order.id, reason: reason.trim() || undefined },
      {
        onSuccess: (result) => {
          setLast(result);
          setOpen(false);
          setReason("");
          if (result.paymentLink.status === "failed") toast.warning("Order cancelled, but the Cashfree payment link could not be cancelled.");
          else if (result.shopify.status === "failed") toast.warning("Order cancelled in the CRM, but the Shopify cancellation failed.");
          else if (result.alreadyCancelled) toast.info("This order was already cancelled.");
          else toast.success("Order cancelled.");
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
      <Button type="button" variant={canRetry ? "outline" : "destructive"} size="sm" onClick={() => (canRetry ? run() : setOpen(true))} disabled={cancel.isPending}>
        <Ban data-icon="inline-start" />
        {canRetry ? (cancel.isPending ? "Retrying…" : retryLabel) : "Cancel order"}
      </Button>

      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel this order?"
        description={`Order ${order.orderNumber} for ${order.customer.name}.`}
        confirmLabel="Cancel order"
        pendingLabel="Cancelling…"
        pending={cancel.isPending}
        destructive
        onConfirm={run}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>The CRM order will be cancelled. It is never deleted - the record, items and payments stay.</li>
          <li>{shopifyLinked ? "Cancelling the linked Shopify order will be attempted. If it fails you can retry it." : "This order is not linked to Shopify, so only the CRM order changes."}</li>
          {hasOpenLink ? <li>The unpaid Cashfree payment link will be cancelled so the customer can&apos;t pay for a cancelled order.</li> : null}
          <li>{hasPaid ? "Payment received. Cancelling this order does not automatically issue a refund - refund it separately if needed." : "Successful payments are never refunded automatically by cancelling."}</li>
        </ul>
        <div className="grid gap-1.5">
          <Label htmlFor="cancel-reason">Reason (optional)</Label>
          <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Created by mistake" />
        </div>
      </ConfirmActionDialog>
    </div>
  );
}
