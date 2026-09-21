"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Copy, Link2, MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCancelPaymentLinkMutation, useCreatePaymentLinkMutation, useRefreshPaymentMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { integrationStatusQueryOptions } from "@/lib/api-client/queries/integrations.queries";
import type { OrderDetail, PaymentDetail } from "@/lib/api-client/types/orders.types";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";
import { DetailField } from "./detail-field";
import { SendPaymentLinkDialog } from "./send-payment-link-dialog";

// Orders that are over cannot be collected on (the backend refuses too; this only avoids offering the button).
const CLOSED_ORDER_STATUSES = new Set(["CANCELLED", "REFUNDED", "RETURNED"]);

/** A payment link that can still be paid: created by the CRM through Cashfree, not yet settled, not yet expired. */
export function isOpenPaymentLink(payment: PaymentDetail, now = Date.now()): boolean {
  return (
    payment.source === "CASHFREE" &&
    (payment.status === "PENDING" || payment.status === "PROCESSING") &&
    (!payment.paymentExpiresAt || new Date(payment.paymentExpiresAt).getTime() > now)
  );
}

function useCashfreeStatus() {
  const token = useAuthStore((s) => s.token);
  return useQuery({ ...integrationStatusQueryOptions(), enabled: Boolean(token) }).data?.cashfree ?? null;
}

/** "Create payment link" for the order's exact pending amount. Nothing is shown unless Cashfree is set up and there is something to collect. */
export function CreatePaymentLinkButton({ order }: { order: OrderDetail }) {
  const cashfree = useCashfreeStatus();
  const create = useCreatePaymentLinkMutation();
  const pending = Number(order.outstandingAmount);
  const hasOpenLink = order.payments.some((p) => isOpenPaymentLink(p));

  if (!cashfree?.configured || CLOSED_ORDER_STATUSES.has(order.status) || !(pending > 0) || hasOpenLink) return null;

  function handleCreate() {
    create.mutate(order.id, {
      onSuccess: (result) => {
        toast.success(result.reused ? "An open payment link already exists for this amount." : "Payment link created.");
        if (!result.webhookRegistered) toast.info("Payment updates are not automatic here - use Refresh to check whether the customer has paid.");
      },
      onError: (error) => toast.error(getErrorMessage(error, "Could not create the payment link.")),
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
      <p className="text-sm text-muted-foreground">
        {formatMoney(order.outstandingAmount, order.currency)} is still to be collected on this order.
      </p>
      <Button type="button" size="sm" onClick={handleCreate} disabled={create.isPending}>
        <Link2 data-icon="inline-start" />
        {create.isPending ? "Creating…" : "Create payment link"}
      </Button>
    </div>
  );
}

/** The payment link of one Cashfree payment, with the actions that make sense for its state. */
export function PaymentLinkPanel({ payment, order }: { payment: PaymentDetail; order: OrderDetail }) {
  const role = useAuthStore((s) => s.user?.role);
  const [sendOpen, setSendOpen] = useState(false);
  const refresh = useRefreshPaymentMutation();
  const cancel = useCancelPaymentLinkMutation();

  if (payment.source !== "CASHFREE") return null;
  const open = isOpenPaymentLink(payment);
  const canCancel = role === "ADMIN" || role === "MANAGER";

  async function copyLink() {
    if (!payment.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(payment.paymentUrl);
      toast.success("Payment link copied.");
    } catch {
      toast.error("Could not copy the link. Select and copy it manually.");
    }
  }

  function handleRefresh() {
    refresh.mutate(payment.id, {
      onSuccess: (result) => toast.success(result.status === "SUCCESS" ? "Payment received." : "Checked with Cashfree - nothing new."),
      onError: (error) => toast.error(getErrorMessage(error, "Could not check the payment with Cashfree.")),
    });
  }

  function handleCancel() {
    if (!window.confirm("Cancel this payment link? The customer will no longer be able to pay through it.")) return;
    cancel.mutate(payment.id, {
      onSuccess: () => toast.success("Payment link cancelled."),
      onError: (error) => toast.error(getErrorMessage(error, "Could not cancel the payment link.")),
    });
  }

  return (
    <div className="space-y-3 rounded-md bg-muted/30 p-3">
      {payment.paymentUrl ? (
        <DetailField label="Payment link">
          <span className="text-xs break-all">{payment.paymentUrl}</span>
        </DetailField>
      ) : (
        <p className="text-xs text-muted-foreground">The link is still being created. Try Create payment link again if it does not appear.</p>
      )}
      {payment.paymentExpiresAt ? (
        <DetailField label={open ? "Expires" : "Expiry"}>{formatDateTime(payment.paymentExpiresAt)}</DetailField>
      ) : null}

      {open && payment.paymentUrl ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={copyLink}>
            <Copy data-icon="inline-start" />
            Copy link
          </Button>
          <Button type="button" size="sm" onClick={() => setSendOpen(true)}>
            <MessageCircle data-icon="inline-start" />
            Send on WhatsApp
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={handleRefresh} disabled={refresh.isPending}>
            <RefreshCw data-icon="inline-start" />
            {refresh.isPending ? "Checking…" : "Refresh"}
          </Button>
          {canCancel ? (
            <Button type="button" size="sm" variant="outline" onClick={handleCancel} disabled={cancel.isPending}>
              <Ban data-icon="inline-start" />
              Cancel link
            </Button>
          ) : null}
        </div>
      ) : null}

      <SendPaymentLinkDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        paymentId={payment.id}
        orderId={order.id}
        leadId={order.customer.leadId}
        customerName={order.customer.name}
      />
    </div>
  );
}
