"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { useSendPaymentLinkAutoMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { formatMoney } from "@/lib/order-status";
import type { PrepaidUpgradeOffer, PrepaidUpgradeView, UpgradeStatus } from "@/lib/api-client/types/prepaid-upgrade.types";
import { ToneBadge, type Tone } from "./shopify-status-badge";

export const UPGRADE_STATUS: Record<UpgradeStatus, { label: string; tone: Tone }> = {
  OFFERED: { label: "Offered", tone: "info" },
  PAYMENT_PENDING: { label: "Payment Pending", tone: "warning" },
  PAYMENT_RECEIVED: { label: "Payment received - review", tone: "danger" },
  UPGRADED: { label: "Prepaid Upgraded", tone: "success" },
  DECLINED: { label: "Declined", tone: "neutral" },
};

const RECON: Record<Exclude<PrepaidUpgradeView["shopifyReconciliation"], "NOT_APPLICABLE">, { label: string; tone: Tone }> = {
  COMPLETED: { label: "Completed", tone: "success" },
  PENDING: { label: "Pending", tone: "warning" },
  FAILED: { label: "Failed - an admin needs to retry", tone: "danger" },
};

/** "Payment received" and "Shopify reconciliation completed" are different facts; this shows the second one (never a technical error). */
export function ShopifyReconciliationLine({ value }: { value: PrepaidUpgradeView["shopifyReconciliation"] | undefined }) {
  if (!value || value === "NOT_APPLICABLE") return null;
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="shopify-reconciliation">
      <span className="text-muted-foreground">Shopify reconciliation</span>
      <ToneBadge tone={RECON[value].tone}>{RECON[value].label}</ToneBadge>
    </div>
  );
}

/** Which view the Prepaid Upgrade dialog shows. An offer that already has a link (or has been paid) never shows the form again. */
export type DialogMode = "form" | "generated";
export function dialogMode(offer: Pick<PrepaidUpgradeOffer, "status"> | null): DialogMode {
  return offer && (offer.status === "PAYMENT_PENDING" || offer.status === "UPGRADED" || offer.status === "PAYMENT_RECEIVED") ? "generated" : "form";
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className={`flex justify-between gap-4 text-sm ${strong ? "border-t pt-2 text-base font-semibold" : ""}`}>
      <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd className={`tabular-nums ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

/**
 * Copy Link + Send on WhatsApp for one generated payment link. Neither ever creates or changes a link: Copy writes the
 * stored URL to the clipboard, Send asks the existing WhatsApp flow to message the customer on their own number. A failed
 * send is shown right here and the link (and Copy) stay exactly as they were.
 */
export function PaymentLinkActions({ url, paymentId }: { url: string; paymentId: string | null }) {
  const [copied, setCopied] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentVia, setSentVia] = useState<string | null>(null);
  const send = useSendPaymentLinkAutoMutation();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Payment link copied");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy - select the link and copy it manually.");
    }
  }

  function sendWhatsApp() {
    if (!paymentId || send.isPending) return;
    setSendError(null);
    setSentVia(null);
    send.mutate(
      { paymentId },
      {
        onSuccess: (r) => {
          if (r.sent) {
            setSentVia(r.via === "FREE_TEXT" ? "message" : "approved template");
            toast.success("Payment link sent on WhatsApp.");
          } else {
            setSendError(r.reason ?? "The WhatsApp message was not sent.");
          }
        },
        onError: (e) => setSendError(getErrorMessage(e, "Could not send the WhatsApp message.")),
      },
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? "Copied" : "Copy Link"}
        </Button>
        {paymentId ? (
          <Button type="button" size="sm" variant="outline" onClick={sendWhatsApp} disabled={send.isPending}>
            <MessageCircle data-icon="inline-start" />
            {send.isPending ? "Sending…" : "Send on WhatsApp"}
          </Button>
        ) : null}
      </div>
      {sentVia ? <p className="text-xs text-emerald-600 dark:text-emerald-400">✓ Sent to the customer on WhatsApp ({sentVia}).</p> : null}
      {sendError ? (
        <p role="alert" className="text-xs text-destructive">
          WhatsApp was not sent: {sendError} The payment link is still valid - you can copy it or try again.
        </p>
      ) : null}
    </div>
  );
}

/** The "Payment Link Generated" state of the Prepaid Upgrade dialog (also reused for an offer that is already paid). */
export function GeneratedPanel({ offer, paymentId, shopifyReconciliation }: { offer: PrepaidUpgradeOffer; paymentId: string | null; shopifyReconciliation?: PrepaidUpgradeView["shopifyReconciliation"] }) {
  const money = (v: string) => formatMoney(v, offer.currency);
  const status = UPGRADE_STATUS[offer.status];
  const upgraded = offer.status === "UPGRADED";
  return (
    <div className="grid gap-3" data-testid="prepaid-upgrade-generated">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
        <Check className="size-4" aria-hidden />
        {upgraded ? "Prepaid Upgraded" : offer.status === "PAYMENT_RECEIVED" ? "Payment received" : "Payment Link Generated"}
      </p>
      <dl className="grid gap-2 rounded-lg border p-3">
        <Row label="Original Amount" value={money(offer.originalAmount)} />
        <Row label="Discount" value={`−${money(offer.discountAmount)}`} tone="text-emerald-600 dark:text-emerald-400" />
        <Row label={upgraded ? "Paid" : "Customer Pays"} value={money(offer.prepaidAmount)} strong />
      </dl>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Status</span>
        <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
      </div>
      {upgraded ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Payment</span>
          <ToneBadge tone="info">Prepaid</ToneBadge>
        </div>
      ) : null}
      {upgraded ? <ShopifyReconciliationLine value={shopifyReconciliation} /> : null}
      {offer.note ? <p role="alert" className="text-xs text-destructive">{offer.note}</p> : null}
      {offer.status === "PAYMENT_PENDING" && offer.paymentUrl ? (
        <div className="grid gap-2">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Payment Link</p>
            <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="prepaid-upgrade-link">{offer.paymentUrl}</p>
          </div>
          <PaymentLinkActions url={offer.paymentUrl} paymentId={paymentId} />
          <p className="text-xs text-muted-foreground">The order stays Cash on Delivery until this link is paid.</p>
        </div>
      ) : null}
    </div>
  );
}
