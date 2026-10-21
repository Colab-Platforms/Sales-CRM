"use client";

import { Button } from "@/components/ui/button";
import { useResyncShopifyMutation } from "@/lib/api-client/mutations/orders.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import type { ShopifySyncRecord } from "@/lib/api-client/types/orders.types";
import { formatDateTime } from "@/lib/order-status";

// The truthful outcome of the last CRM -> Shopify sync, as verified by reading the Shopify order back. Shown on the order page next to the other Shopify sync states; the re-sync button only verifies / repairs
// (it never creates an order or touches payment, fulfilment or totals) and is offered to administrators and managers only.

const FIELD_LABELS: Record<string, string> = {
  shippingAddress: "Shipping address",
  "shippingAddress.fields": "Shipping address (incomplete)",
  "shippingAddress.name": "Recipient name",
  "lineItems.requiresShipping": "Products marked as shipping-required",
  tags: "Tags",
  note: "Order note",
  metafields: "CRM metafields",
  totals: "Order total (does not match the CRM)",
  "financialStatus(unexpectedly paid)": "Payment status (Shopify shows paid)",
};
const label = (f: string) => FIELD_LABELS[f] ?? f;

export function advice(sync: ShopifySyncRecord, canResync: boolean): string | null {
  if (sync.status === "complete") return null;
  if (sync.retryAdvice === "ADMIN") return "Re-syncing will not fix this: it needs an administrator's decision in Shopify (for example a customer or product-setting change).";
  if (sync.retryAdvice === "RETRY") return canResync ? "Re-sync to verify and repair the missing fields." : "Ask an administrator or manager to re-sync this order.";
  return null;
}

export function ShopifySyncBody({ sync, canResync, onResync, pending, error }: { sync: ShopifySyncRecord; canResync: boolean; onResync: () => void; pending: boolean; error: string | null }) {
  const tone = sync.status === "complete" ? "text-emerald-600" : sync.status === "partial" ? "text-amber-600" : "text-destructive";
  const next = advice(sync, canResync);
  return (
    <div className="space-y-2 text-sm" data-testid="shopify-sync" data-state={sync.status}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Shopify sync:</span>
        <span className={`font-semibold ${tone}`} data-testid="shopify-sync-status">{sync.status === "complete" ? "Complete - verified on Shopify" : sync.status === "partial" ? "Partial - some details are not on Shopify" : "Failed"}</span>
      </p>
      <p className="text-xs text-muted-foreground">Last attempt {formatDateTime(sync.attemptedAt)}{sync.verifiedAt ? ` · last verified ${formatDateTime(sync.verifiedAt)}` : " · not fully verified yet"}</p>
      {sync.missing.length > 0 ? (
        <ul className="list-disc pl-5 text-xs" data-testid="shopify-sync-missing">
          {sync.missing.map((m) => <li key={m}>{label(m)}</li>)}
        </ul>
      ) : null}
      {sync.error ? <p role="alert" className="text-xs text-destructive" data-testid="shopify-sync-error">{sync.error}</p> : null}
      {sync.repaired.length > 0 ? <p className="text-xs text-muted-foreground">Repaired on the last attempt: {sync.repaired.map(label).join(", ")}</p> : null}
      {sync.omitted.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Not sent ({sync.omitted.length})</summary>
          <ul className="list-disc pl-5">{sync.omitted.map((o) => <li key={o}>{o}</li>)}</ul>
        </details>
      ) : null}
      {next ? <p className="text-xs" data-testid="shopify-sync-advice">{next}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {canResync && sync.status !== "complete" && sync.retryAdvice !== "ADMIN" ? (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onResync} data-testid="shopify-resync">{pending ? "Re-syncing..." : "Re-sync with Shopify"}</Button>
      ) : null}
    </div>
  );
}

export function ShopifySyncStatus({ orderId, sync, role }: { orderId: string; sync: ShopifySyncRecord | null | undefined; role: string | undefined }) {
  const mutation = useResyncShopifyMutation();
  if (!sync) return null;
  const result = mutation.data?.reason && !mutation.data.sync ? mutation.data.reason : null;
  return (
    <ShopifySyncBody
      sync={sync}
      canResync={role === "ADMIN" || role === "MANAGER"}
      onResync={() => mutation.mutate(orderId)}
      pending={mutation.isPending}
      error={mutation.isError ? getErrorMessage(mutation.error, "Could not re-sync with Shopify.") : result}
    />
  );
}

/** A prepaid order whose payment has not been verified yet: a payment request, not a confirmed order, and not in Shopify. */
export function isAwaitingPayment(order: { status: string; paymentMode: string | null; externalNumber: string | null }): boolean {
  return order.status === "PENDING_PAYMENT" && order.paymentMode !== "COD" && !order.externalNumber;
}

export function AwaitingPaymentNotice() {
  return (
    <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200" data-testid="awaiting-payment-notice">
      <span className="font-semibold">Awaiting payment.</span> This is a payment request, not a confirmed order. The Shopify order is created automatically once Cashfree confirms the payment; a payment link, a screenshot or a customer&apos;s message does not confirm it.
    </p>
  );
}
