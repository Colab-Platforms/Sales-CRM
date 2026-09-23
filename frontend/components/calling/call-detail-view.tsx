"use client";

import Link from "next/link";
import { ArrowLeft, Mic } from "lucide-react";
import { buttonVariants, Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { leadDetailHref } from "@/components/leads/lead-table";
import { useCallHistoryDetail } from "@/hooks/useCallHistory";
import { CallStatusBadge } from "./call-status-badge";
import { CallingIdentity } from "./calling-identity";
import { CALL_DIRECTION_LABELS, formatCallDuration } from "@/lib/call-status";

const CALLING_HREF = "/dashboard/calling";

function BackLink() {
  return (
    <Link href={CALLING_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to Call History
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading call">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64" />
    </div>
  );
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function CallDetailView({ callId }: { callId: string }) {
  const { data: call, isLoading, error, refetch } = useCallHistoryDetail(callId);

  if (isLoading) return <DetailSkeleton />;

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div role="alert" className="sketch-outline flex flex-col items-start gap-3 border-destructive/30 bg-destructive/10 p-6">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!call) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="sketch-outline bg-card/60 p-6 text-sm text-muted-foreground">Call not found.</div>
      </div>
    );
  }

  const customerName = `${call.lead.firstName} ${call.lead.lastName ?? ""}`.trim();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="sketch-underline font-heading text-2xl font-extrabold tracking-tight">Call with {customerName}</h1>
          <CallStatusBadge status={call.status} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Call Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailGrid>
            <DetailField label="Customer">
              <Link href={leadDetailHref(call.lead.id)} className="font-medium hover:underline">
                {customerName}
              </Link>
            </DetailField>
            <DetailField label="Lead number">
              <span className="font-mono text-sm">{call.lead.leadNumber}</span>
            </DetailField>
            <DetailField label="Mobile">{call.lead.mobile ?? "No mobile on file"}</DetailField>
            <DetailField label="Salesperson">{call.agent.name}</DetailField>
            <DetailField label="Direction">{CALL_DIRECTION_LABELS[call.direction]}</DetailField>
            <DetailField label="Status">
              <CallStatusBadge status={call.status} />
            </DetailField>
            <DetailField label="Started">{formatDateTime(call.startedAt)}</DetailField>
            <DetailField label="Answered">{formatDateTime(call.answeredAt)}</DetailField>
            <DetailField label="Ended">{formatDateTime(call.endedAt)}</DetailField>
            <DetailField label="Duration">{formatCallDuration(call.durationSeconds)}</DetailField>
            <DetailField label="Outcome / Disposition">{call.outcome?.name ?? "—"}</DetailField>
            <DetailField label="Recording">
              {call.hasRecording ? (
                <span className="flex items-center gap-1.5">
                  <Mic className="size-3.5" aria-hidden="true" /> Recording available
                </span>
              ) : (
                "—"
              )}
            </DetailField>
          </DetailGrid>

          <div className="border-t pt-4">
            <CallingIdentity identity={call.callingIdentity} pendingMessage="Not recorded for this call" />
          </div>

          <div className="border-t pt-4">
            <h3 className="mb-1 text-sm font-medium">Notes</h3>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{call.notes ?? "—"}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
