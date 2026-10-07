"use client";

import { useState } from "react";
import { Check, Repeat2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DiscountEditor } from "@/components/discounts/discount-editor";
import { useDiscountOptions } from "@/hooks/useDiscountOptions";
import { choiceCaption, choiceCents, defaultChoice, toApiDiscount, type DiscountChoice } from "@/lib/discount";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreatePrepaidOffer, useDeclinePrepaidOffer, useGeneratePrepaidLink, usePrepaidUpgrade, type UpgradeTarget } from "@/hooks/usePrepaidUpgrade";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import type { PrepaidUpgradeOffer, PrepaidUpgradeView } from "@/lib/api-client/types/prepaid-upgrade.types";
import { AccentCard, SectionTitle } from "./order-detail-parts";
import { PREPAID_UPGRADE_ANCHOR } from "./prepaid-upgrade-action";
import { ToneBadge } from "./shopify-status-badge";
import { GeneratedPanel, PaymentLinkActions, ShopifyReconciliationLine, UPGRADE_STATUS, dialogMode } from "./prepaid-upgrade-link-panel";

const cents = (v: string) => Math.round(Number(v) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);
function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className={`flex justify-between gap-4 text-sm ${strong ? "border-t pt-2 text-base font-semibold" : ""}`}>
      <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd className={`tabular-nums ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

function UpgradeDialog({ target, view, open, onOpenChange }: { target: UpgradeTarget; view: PrepaidUpgradeView; open: boolean; onOpenChange: (open: boolean) => void }) {
  // The default coupon (configured server-side, UPGRADE flow) is pre-selected; an edit REPLACES it, it is never stacked.
  const [discountEdit, setDiscountEdit] = useState<DiscountChoice | null>(null);
  const [editing, setEditing] = useState(false);
  const { options: discountOptions, loaded: discountsLoaded } = useDiscountOptions("UPGRADE", open);
  const choice: DiscountChoice = discountEdit ?? defaultChoice(discountOptions);
  // The offer just generated here, shown immediately (the refetch that follows then keeps it fresh: pending -> upgraded...).
  const [generated, setGenerated] = useState<{ offer: PrepaidUpgradeOffer; paymentId: string | null } | null>(null);
  const create = useCreatePrepaidOffer(target);
  const link = useGeneratePrepaidLink();
  const busy = create.isPending || link.isPending;
  const original = cents(view.orderAmount);
  // Preview of the server's strict rule (the discount must leave something to pay); the server recomputes and confirms it.
  const discountCents = choiceCents(original, choice, true);
  const valid = choice.mode !== "NONE" && discountCents > 0 && discountCents < original;
  const prepaidCents = original - discountCents;

  // The server's latest copy of the offer wins over the one captured at generation time.
  const offer = view.offer && (!generated || view.offer.id === generated.offer.id) ? view.offer : (generated?.offer ?? view.offer);
  const paymentId = offer?.id === generated?.offer.id ? (generated?.paymentId ?? offer?.paymentId ?? null) : (offer?.paymentId ?? null);
  const mode = dialogMode(offer);

  // Create the offer, then its payment link, in one click, and STAY in this dialog. The server recomputes the amount from
  // `type` + `value` only; the discount the telecaller typed is left as it is.
  function generate() {
    if (busy || !valid) return;
    const api = toApiDiscount(choice);
    create.mutate(
      { ...("couponCode" in api ? { couponCode: api.couponCode } : "type" in api ? { discountType: api.type, discountValue: api.value } : {}), expectedPrepaidAmount: fromCents(prepaidCents) },
      {
        onSuccess: (offered) => {
          // `orderId` is the CRM order the offer now lives on - for a Shopify order the CRM had not seen, the first offer just created it.
          if (!offered.offer || !offered.orderId) return;
          link.mutate(
            { orderId: offered.orderId, upgradeId: offered.offer.id },
            {
              onSuccess: (r) => {
                if (r.offer) setGenerated({ offer: r.offer, paymentId: r.paymentId });
                toast.success("Payment link generated.");
              },
              onError: (e) => toast.error(getErrorMessage(e, "The offer was saved but the payment link could not be generated.")),
            },
          );
        },
        onError: (e) => toast.error(getErrorMessage(e, "Could not create the offer.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Prepaid Upgrade</DialogTitle>
          <DialogDescription>{mode === "generated" ? "Share the payment link with the customer." : "Offer a discount if the customer pays online instead of Cash on Delivery."}</DialogDescription>
        </DialogHeader>

        {mode === "generated" && offer ? (
          <>
            <GeneratedPanel offer={offer} paymentId={paymentId} shopifyReconciliation={view.shopifyReconciliation} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <dl className="grid gap-2 rounded-lg border bg-muted/40 p-3">
              <Row label="Current COD amount" value={formatMoney(view.orderAmount, view.currency)} strong />
            </dl>

            <dl className="grid gap-2 rounded-lg border p-3" data-testid="upgrade-summary">
              <Row label="Original Amount" value={formatMoney(view.orderAmount, view.currency)} />
              <div className="flex items-center justify-between gap-4 text-sm">
                <dt className="text-muted-foreground">
                  Discount
                  {choiceCaption(choice) ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{choiceCaption(choice)}</span> : null}
                </dt>
                <dd className="flex items-center gap-2">
                  <span className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">−{formatMoney(fromCents(discountCents), view.currency)}</span>
                  <button type="button" onClick={() => setEditing(true)} disabled={busy || !discountsLoaded} className="text-xs font-medium text-primary hover:underline disabled:opacity-50">Edit</button>
                </dd>
              </div>
              <Row label="Customer Pays" value={valid ? formatMoney(fromCents(prepaidCents), view.currency) : "—"} strong />
            </dl>
            {!valid && discountsLoaded ? <p role="alert" className="text-xs text-destructive">Choose a discount that is more than 0 and less than the order amount.</p> : null}
            <DiscountEditor open={editing} onOpenChange={setEditing} current={choice} fastrr={discountOptions.fastrr} baseCents={original} currency={view.currency} strict onApply={setDiscountEdit} />
            <p className="text-xs text-muted-foreground">The order stays Cash on Delivery at the original amount until the customer actually pays; the final amount is confirmed by the server.</p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button type="button" onClick={generate} disabled={busy || !valid}>
                {busy ? "Generating…" : "Generate Payment Link"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OfferSummary({ offer, orderId, paymentId, shopifyReconciliation }: { offer: PrepaidUpgradeOffer; orderId: string | null; paymentId: string | null; shopifyReconciliation: PrepaidUpgradeView["shopifyReconciliation"] }) {
  const decline = useDeclinePrepaidOffer();
  const upgraded = offer.status === "UPGRADED";
  const money = (v: string) => formatMoney(v, offer.currency);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={UPGRADE_STATUS[offer.status].tone}>{upgraded ? <Check className="size-3" aria-hidden /> : null}{UPGRADE_STATUS[offer.status].label}</ToneBadge>
        <span className="text-xs text-muted-foreground">Offered {formatDateTime(offer.createdAt)}{offer.createdByName ? ` by ${offer.createdByName}` : ""}</span>
      </div>
      <dl className="grid gap-1.5 rounded-lg border p-3">
        <Row label={upgraded ? "Original COD" : "COD Amount"} value={money(offer.originalAmount)} />
        <Row label="Discount" value={`${offer.discountType === "PERCENT" ? `${Number(offer.discountValue)}% · ` : ""}${money(offer.discountAmount)}`} tone="text-emerald-600 dark:text-emerald-400" />
        <Row label={upgraded ? "Paid" : "Prepaid Amount"} value={money(offer.prepaidAmount)} strong />
      </dl>
      {upgraded ? <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">✓ Prepaid Upgraded{offer.upgradedAt ? ` · ${formatDateTime(offer.upgradedAt)}` : ""}</p> : null}
      {upgraded ? <ShopifyReconciliationLine value={shopifyReconciliation} /> : null}
      {offer.note ? <p role="alert" className="text-xs text-destructive">{offer.note}</p> : null}
      {offer.lastPaymentFailure ? <p className="text-xs text-muted-foreground">Last link did not complete ({offer.lastPaymentFailure.reason}). The order is still COD.</p> : null}

      {offer.status === "PAYMENT_PENDING" && offer.paymentUrl ? (
        <div className="grid gap-2">
          <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{offer.paymentUrl}</p>
          <PaymentLinkActions url={offer.paymentUrl} paymentId={paymentId} />
          <div>
            <Button type="button" size="sm" variant="ghost" disabled={decline.isPending || !orderId} onClick={() => orderId && decline.mutate({ orderId, upgradeId: offer.id }, { onSuccess: () => toast.success("Offer declined - order stays COD."), onError: (e) => toast.error(getErrorMessage(e, "Could not decline the offer.")) })}>
              Customer declined
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">The order stays COD until this link is paid.</p>
        </div>
      ) : null}
    </div>
  );
}

// Order Detail panel for the telecaller's "pay online for a discount" offer: status, amounts, link actions. Its ONE entry
// point for starting/changing an offer is the "Prepaid Upgrade" button in the page header next to Cancel Order
// (PrepaidUpgradeAction), which opens the dialog owned here via `open`/`onOpenChange` - there is no second button.
// Shown only for COD orders (eligible or explained) or once an offer exists. All amounts and the COD -> prepaid conversion
// are server-side; this only collects the typed discount.
export function PrepaidUpgradeCard({ target, open, onOpenChange }: { target: UpgradeTarget; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data, isLoading, error } = usePrepaidUpgrade(target);
  if (isLoading) return null;
  // A failed lookup must be visible - silently rendering nothing is exactly how this card once looked "missing".
  if (error || !data) {
    return (
      <div id={PREPAID_UPGRADE_ANCHOR}>
      <AccentCard accent="amber">
        <SectionTitle icon={<Repeat2 />} accent="amber">Prepaid Upgrade</SectionTitle>
        <CardContent>
          <p role="alert" className="text-sm text-destructive">{error ?? "Could not load the prepaid upgrade."}</p>
        </CardContent>
      </AccentCard>
      </div>
    );
  }
  const offer = data.offer;
  // Prepaid orders never see the feature. A COD order that cannot be upgraded right now (already paid, cancelled...)
  // shows why, instead of the card just not being there.
  if (!data.eligible && !offer && !data.isCod) return null;
  if (!data.eligible && !offer) {
    return (
      <div id={PREPAID_UPGRADE_ANCHOR}>
        <AccentCard accent="slate">
          <SectionTitle icon={<Repeat2 />}>Prepaid Upgrade</SectionTitle>
          <CardContent>
            <p className="text-sm text-muted-foreground">Prepaid Upgrade unavailable. Reason: {data.reason ?? "it is not eligible."}</p>
          </CardContent>
        </AccentCard>
      </div>
    );
  }

  const canOffer = data.eligible && (!offer || offer.status === "OFFERED" || offer.status === "DECLINED");
  return (
    <div id={PREPAID_UPGRADE_ANCHOR}>
    <AccentCard accent="amber">
      <SectionTitle icon={<Repeat2 />} accent="amber">Prepaid Upgrade</SectionTitle>
      <CardContent className="grid gap-3">
        {offer && offer.status !== "DECLINED" ? <OfferSummary shopifyReconciliation={data.shopifyReconciliation} offer={offer} orderId={data.orderId} paymentId={data.offer?.paymentId ?? null} /> : null}
        {offer?.status === "DECLINED" ? <p className="text-sm text-muted-foreground">The customer declined the last offer ({formatMoney(offer.discountAmount, offer.currency)} off). The order is still COD.</p> : null}
        {!offer ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <p className="text-muted-foreground">Payment</p>
              <p className="font-medium">COD · {formatMoney(data.orderAmount, data.currency)}</p>
            </div>
          </div>
        ) : null}
        {canOffer ? <p className="text-xs text-muted-foreground">{offer?.status === "OFFERED" ? "Use Prepaid Upgrade at the top of the page to change this offer or generate its payment link." : "Use Prepaid Upgrade at the top of the page to offer the customer a discount for paying online."}</p> : null}
        {data.history.length > 0 ? <p className="text-xs text-muted-foreground">{data.history.length} earlier offer{data.history.length === 1 ? "" : "s"} on this order.</p> : null}
      </CardContent>
      <UpgradeDialog target={target} view={data} open={open} onOpenChange={onOpenChange} />
    </AccentCard>
    </div>
  );
}
