"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCustomer360 } from "@/hooks/useCustomers";
import { CustomerProfileCard } from "./customer-profile-card";
import { CustomerSegmentCard } from "./customer-segment-card";
import { NextBestActionCard } from "./next-best-action-card";
import { CustomerPaymentSummaryCard } from "./customer-payment-summary-card";
import { CustomerOrdersList } from "./customer-orders-list";
import { CustomerTimeline } from "./customer-timeline";

const ORDERS_HREF = "/dashboard/orders";

function BackLink() {
  return (
    <Link href={ORDERS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to orders
    </Link>
  );
}

function Customer360Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading customer">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40" />
      <Skeleton className="h-32" />
      <Skeleton className="h-48" />
    </div>
  );
}

export function Customer360View({ leadId }: { leadId: string }) {
  const { data, isLoading, error, refetch } = useCustomer360(leadId);

  if (isLoading) return <Customer360Skeleton />;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div role="alert" className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm text-destructive">{error ?? "Failed to load customer."}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const currency = data.latestOrder?.currency ?? "INR";

  return (
    <div className="space-y-6">
      <BackLink />
      <CustomerProfileCard customer={data} />
      <CustomerSegmentCard segment={data.segment} currency={currency} />
      <NextBestActionCard nba={data.nextBestAction} />
      <CustomerPaymentSummaryCard summary={data.paymentSummary} currency={currency} />
      <CustomerOrdersList orders={data.orders} />
      <CustomerTimeline leadId={leadId} />
      <div>
        <Link href={`/dashboard/audit?leadId=${leadId}`} className="text-sm text-primary hover:underline">
          View full audit trail for this customer
        </Link>
      </div>
    </div>
  );
}
