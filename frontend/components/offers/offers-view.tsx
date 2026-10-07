"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clock, Copy, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { AccentCard, EmptyState } from "@/components/orders/order-detail-parts";
import { ToneBadge } from "@/components/orders/shopify-status-badge";
import { useActiveOffers } from "@/hooks/useActiveOffers";
import { formatDate, formatMoney } from "@/lib/order-status";
import type { ActiveOffer } from "@/lib/api-client/types/offers.types";

export function offerHeadline(offer: Pick<ActiveOffer, "discountType" | "discountValue">): string {
  const type = offer.discountType?.toLowerCase();
  if (type === "percentage" && offer.discountValue !== null) return `${offer.discountValue}% OFF`;
  if (type === "flat" && offer.discountValue !== null) return `${formatMoney(String(offer.discountValue))} OFF`;
  if (type === "freebie") return "Free gift";
  return offer.discountType ? `${offer.discountType} offer` : "Offer";
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success(`Copied ${code}`);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy the code - select it and copy manually.");
    }
  }

  return (
    <Button type="button" size="sm" variant={copied ? "secondary" : "outline"} onClick={copy} aria-label={`Copy code ${code}`}>
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {copied ? "Copied" : "Copy Code"}
    </Button>
  );
}

export function OfferCard({ offer }: { offer: ActiveOffer }) {
  const hasProductFilter = Array.isArray(offer.productFilter) ? offer.productFilter.length > 0 : offer.productFilter !== null && offer.productFilter !== undefined && offer.productFilter !== "";
  return (
    <AccentCard accent={offer.expiringSoon ? "amber" : "green"} className="h-full">
      <div className="flex h-full flex-col gap-4 px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Ticket className="size-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
            <span className="font-mono text-base font-bold tracking-wide break-all">{offer.couponCode ?? "Automatic discount"}</span>
          </div>
          {offer.expiringSoon ? (
            <ToneBadge tone="warning">
              <Clock className="size-3" aria-hidden />
              Expires soon
            </ToneBadge>
          ) : (
            <ToneBadge tone="success">Active</ToneBadge>
          )}
        </div>

        <div>
          <p className="text-3xl font-bold tracking-tight tabular-nums">{offerHeadline(offer)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {offer.automaticDiscount !== null ? <ToneBadge tone="info">{offer.automaticDiscount ? "Automatic" : "Coupon code"}</ToneBadge> : null}
            {offer.discountType ? <ToneBadge tone="neutral">{titleCase(offer.discountType)}</ToneBadge> : null}
          </div>
        </div>

        <dl className="grid gap-1.5 text-sm">
          {offer.minCartTotal !== null ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Minimum order</dt>
              <dd className="font-medium tabular-nums">{formatMoney(String(offer.minCartTotal))}</dd>
            </div>
          ) : null}
          {offer.minQtyProduct !== null ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Minimum quantity</dt>
              <dd className="font-medium tabular-nums">{offer.minQtyProduct}</dd>
            </div>
          ) : null}
          {hasProductFilter ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Eligibility</dt>
              <dd className="font-medium">Selected products only</dd>
            </div>
          ) : null}
          {offer.startTime ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Valid from</dt>
              <dd className="font-medium">{formatDate(offer.startTime)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Valid until</dt>
            <dd className="font-medium">{offer.endTime ? formatDate(offer.endTime) : "No expiry"}</dd>
          </div>
        </dl>

        {offer.couponCode ? (
          <div className="mt-auto flex justify-end">
            <CopyCodeButton code={offer.couponCode} />
          </div>
        ) : (
          <p className="mt-auto text-xs text-muted-foreground">Applied automatically at checkout - no code to enter.</p>
        )}
      </div>
    </AccentCard>
  );
}

function OfferCardSkeleton() {
  return (
    <div className="grid gap-4 rounded-xl border-[1.5px] border-border p-5" aria-hidden>
      <div className="flex justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-9 w-28" />
      <div className="grid gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
      <Skeleton className="ml-auto h-8 w-28" />
    </div>
  );
}

export function OffersView() {
  const { data, isLoading, isFetching, error, refetch } = useActiveOffers();

  let content;
  if (isLoading) {
    content = (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading active offers">
        {Array.from({ length: 3 }).map((_, i) => (
          <OfferCardSkeleton key={i} />
        ))}
      </div>
    );
  } else if (error || !data) {
    content = (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-destructive">Unable to load active offers from Fastrr.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  } else if (data.offers.length === 0) {
    content = <EmptyState icon={<Ticket className="size-6 text-muted-foreground" aria-hidden />} title="No active offers" message="No promotional offers are currently available." />;
  } else {
    content = (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data.offers.map((offer, i) => (
          <OfferCard key={offer.id ?? `${offer.couponCode}-${i}`} offer={offer} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Active Offers" description="Current promotional offers from Fastrr Checkout." />
      {content}
    </div>
  );
}
