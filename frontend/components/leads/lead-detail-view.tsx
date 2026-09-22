"use client";

import axios from "axios";
import Link from "next/link";
import { ArrowLeft, MessageCircle, Phone, SearchX } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { leadDetailQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { LeadStatusSelect } from "@/components/leads/lead-table";
import { LeadActivitySection } from "@/components/leads/lead-activity-section";
import { CallCustomerDialog } from "@/components/calling/call-customer-dialog";
import { CallStatusCard } from "@/components/calling/call-status-card";
import { useCallCustomer } from "@/hooks/useCallCustomer";
import type { Lead } from "@/lib/api-client/types/lead.types";

const LEADS_HREF = "/dashboard/leads";

function BackLink() {
  return (
    <Link href={LEADS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to Leads
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading lead">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32" />
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}

function NotFoundState() {
  return (
    <div className="space-y-4">
      <BackLink />
      <div role="alert" className="sketch-outline flex flex-col items-start gap-3 bg-card/60 p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <SearchX className="size-5" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">Lead not found</p>
        </div>
        <p className="text-sm text-muted-foreground">
          This lead may have been removed, or you may not have access to it.
        </p>
        <Link href={LEADS_HREF} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Back to Leads
        </Link>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-4">
      <BackLink />
      <div role="alert" className="sketch-outline flex flex-col items-start gap-3 border-destructive/30 bg-destructive/10 p-6">
        <p className="text-sm text-destructive">{message}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
          <Link href={LEADS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Back to Leads
          </Link>
        </div>
      </div>
    </div>
  );
}

// WhatsApp stays presentational, per this step's scope — only Call Customer is wired to a real
// backend call. Neither button ever talks to a telephony provider directly; the frontend only
// ever calls our own POST /api/calls.
function ActionButtons({ lead, onCallCustomer }: { lead: Lead; onCallCustomer: () => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2.5">
      <Button onClick={onCallCustomer}>
        <Phone data-icon="inline-start" />
        Call Customer
      </Button>
      <Button variant="outline" onClick={() => toast.info("WhatsApp messaging is coming soon.")}>
        <MessageCircle data-icon="inline-start" />
        WhatsApp
      </Button>
      {!lead.mobile ? <p className="w-full text-xs text-muted-foreground">This lead has no mobile number on file.</p> : null}
    </div>
  );
}

function LeadHeader({ lead, onCallCustomer }: { lead: Lead; onCallCustomer: () => void }) {
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(" ");

  return (
    <div className="space-y-3">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="sketch-underline font-heading text-2xl font-extrabold tracking-tight">{fullName}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
            <span className="font-mono text-xs">{lead.leadNumber}</span>
            <StatusBadge status={lead.workingStatus} />
            <span>Source: {lead.source?.name ?? "—"}</span>
            <span>Salesperson: {lead.owner?.name ?? "—"}</span>
            <span>Created {new Date(lead.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        <ActionButtons lead={lead} onCallCustomer={onCallCustomer} />
      </div>
    </div>
  );
}

function CustomerInformationCard({ lead }: { lead: Lead }) {
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(" ");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer Information</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailGrid>
          <DetailField label="Customer name">{fullName}</DetailField>
          <DetailField label="Mobile">{lead.mobile ?? "—"}</DetailField>
          <DetailField label="Email">{lead.email ?? "—"}</DetailField>
          <DetailField label="Requirement / Product">{lead.requirement ?? "—"}</DetailField>
          <DetailField label="Source">{lead.source?.name ?? "—"}</DetailField>
          <DetailField label="Lead status">
            <StatusBadge status={lead.workingStatus} />
          </DetailField>
          <DetailField label="Priority">{lead.priority}</DetailField>
          <DetailField label="Assigned salesperson">{lead.owner?.name ?? "—"}</DetailField>
          {lead.assignedManager ? <DetailField label="Manager">{lead.assignedManager.name}</DetailField> : null}
          {lead.group ? <DetailField label="Group">{lead.group.name}</DetailField> : null}
          <DetailField label="Created date">{new Date(lead.createdAt).toLocaleDateString()}</DetailField>
        </DetailGrid>
        {lead.location ? (
          <p className="mt-4 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Location:</span> {lead.location}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LeadStatusCard({ lead, isSalesperson }: { lead: Lead; isSalesperson: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead Status</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <StatusBadge status={lead.workingStatus} className="h-7 px-3 text-sm" />
        {isSalesperson ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Change status:</span>
            <LeadStatusSelect lead={lead} />
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            Only the assigned salesperson can change this lead&apos;s status.
          </span>
        )}
      </CardContent>
    </Card>
  );
}

export function LeadDetailView({ leadId }: { leadId: string }) {
  const role = useAuthStore((s) => s.user?.role);
  // Called unconditionally, ahead of the lead-loading early returns below (Rules of Hooks) — it
  // only needs `leadId`, which is available immediately as a prop. This also means a call that's
  // still in flight survives a lead refetch/re-render instead of being reset by it.
  const call = useCallCustomer(leadId);
  const { data: lead, isPending, error, refetch } = useQuery(leadDetailQueryOptions(leadId));

  if (isPending) return <DetailSkeleton />;

  if (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return <NotFoundState />;
    }
    return <ErrorState message={getErrorMessage(error, "Failed to load lead.")} onRetry={() => refetch()} />;
  }

  if (!lead) return <NotFoundState />;

  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(" ");

  return (
    <div className="space-y-6">
      <LeadHeader lead={lead} onCallCustomer={call.openDialog} />

      {call.result ? (
        <CallStatusCard
          status={call.result.status}
          customerName={fullName}
          callId={call.result.callId}
          callingIdentity={call.result.callingIdentity}
          onDismiss={call.dismissResult}
        />
      ) : null}

      <CustomerInformationCard lead={lead} />
      <LeadStatusCard lead={lead} isSalesperson={role === "SALESPERSON"} />
      <LeadActivitySection leadId={lead.id} />

      <CallCustomerDialog
        open={call.dialogOpen}
        onOpenChange={(open) => { if (!open) call.closeDialog(); }}
        customerName={fullName}
        customerMobile={lead.mobile}
        isPending={call.isPending}
        failure={call.failure}
        onStartCall={call.startCall}
        onRetry={call.retry}
      />
    </div>
  );
}
