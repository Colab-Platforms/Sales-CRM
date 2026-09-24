"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCancelCampaignMutation, useLaunchCampaignMutation } from "@/lib/api-client/mutations/whatsapp-campaigns.mutations";
import { whatsappCampaignDetailQueryOptions, whatsappCampaignRecipientsQueryOptions } from "@/lib/api-client/queries/whatsapp-campaigns.queries";
import type { WhatsAppCampaignRecipientStatus } from "@/lib/api-client/types/whatsapp-campaigns.types";
import { CAMPAIGN_STATUS_COLORS, CAMPAIGN_STATUS_LABELS, RECIPIENT_STATUS_COLORS, RECIPIENT_STATUS_LABELS } from "@/lib/whatsapp-campaign-status";
import { MESSAGE_STATUS_COLORS, MESSAGE_STATUS_LABELS } from "@/lib/whatsapp-message-status";
import { formatDateTime } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";

const PAGE_SIZE = 25;
const ALL = "ALL";
const RECIPIENT_STATUS_ITEMS: Record<string, string> = { [ALL]: "All", ...RECIPIENT_STATUS_LABELS };

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}

export function WhatsAppCampaignDetailView({ id }: { id: string }) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const [page, setPage] = useState(1);
  const [recipientStatus, setRecipientStatus] = useState<WhatsAppCampaignRecipientStatus | undefined>(undefined);
  const [scheduleAt, setScheduleAt] = useState("");

  const detailQuery = useQuery({ ...whatsappCampaignDetailQueryOptions(id), enabled: Boolean(user) });
  const recipientsQuery = useQuery({ ...whatsappCampaignRecipientsQueryOptions(id, { page, pageSize: PAGE_SIZE, status: recipientStatus }), enabled: Boolean(user) });

  const launchMutation = useLaunchCampaignMutation();
  const cancelMutation = useCancelCampaignMutation();

  if (detailQuery.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading campaign">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (detailQuery.error || !detailQuery.data) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(detailQuery.error, "Failed to load campaign.")}
        </p>
      </div>
    );
  }

  const campaign = detailQuery.data;
  const canLaunch = isAdmin && campaign.status === "DRAFT";
  const canCancel = isAdmin && (campaign.status === "DRAFT" || campaign.status === "SCHEDULED" || campaign.status === "RUNNING");

  function handleLaunch(now: boolean) {
    const scheduledAt = !now && scheduleAt ? new Date(scheduleAt).toISOString() : undefined;
    launchMutation.mutate(
      { id, input: { scheduledAt } },
      {
        onSuccess: () => toast.success(now ? "Campaign launched." : "Campaign scheduled."),
        onError: (err) => toast.error(getErrorMessage(err, "Failed to launch campaign.")),
      },
    );
  }

  function handleCancel() {
    cancelMutation.mutate(id, {
      onSuccess: () => toast.success("Campaign cancelled."),
      onError: (err) => toast.error(getErrorMessage(err, "Failed to cancel campaign.")),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/dashboard/whatsapp/campaigns" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <ArrowLeft data-icon="inline-start" />
        Back to campaigns
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
          {campaign.description ? <p className="text-sm text-muted-foreground">{campaign.description}</p> : null}
        </div>
        <Badge className={CAMPAIGN_STATUS_COLORS[campaign.status]}>{CAMPAIGN_STATUS_LABELS[campaign.status]}</Badge>
      </div>

      {campaign.status === "FAILED" && campaign.failureReason ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {campaign.failureReason}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total recipients" value={campaign.stats.totalRecipients} />
          <StatCard label="Sent" value={campaign.stats.sent} />
          <StatCard label="Delivered" value={campaign.stats.delivered} />
          <StatCard label="Read" value={campaign.stats.read} />
          <StatCard label="Failed" value={campaign.stats.failed} />
          <StatCard label="Skipped" value={campaign.stats.skipped} />
          <StatCard label="Pending" value={campaign.stats.pending} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <p>
            <span className="text-muted-foreground">Template:</span> {campaign.template?.name ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Created by:</span> {campaign.createdBy?.name ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Created:</span> {formatDateTime(campaign.createdAt)}
          </p>
          <p>
            <span className="text-muted-foreground">Scheduled:</span> {campaign.scheduledAt ? formatDateTime(campaign.scheduledAt) : "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Started:</span> {campaign.startedAt ? formatDateTime(campaign.startedAt) : "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Completed:</span> {campaign.completedAt ? formatDateTime(campaign.completedAt) : "—"}
          </p>
          {campaign.cancelledAt ? (
            <p>
              <span className="text-muted-foreground">Cancelled:</span> {formatDateTime(campaign.cancelledAt)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {(canLaunch || canCancel) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">7. Send</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            {canLaunch ? (
              <>
                <Button onClick={() => handleLaunch(true)} disabled={launchMutation.isPending}>
                  Send now
                </Button>
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-at" className="text-xs text-muted-foreground">
                    Or schedule for later
                  </Label>
                  <Input id="schedule-at" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                </div>
                <Button variant="outline" onClick={() => handleLaunch(false)} disabled={launchMutation.isPending || !scheduleAt}>
                  Schedule
                </Button>
              </>
            ) : null}
            {canCancel ? (
              <Button variant="destructive" onClick={handleCancel} disabled={cancelMutation.isPending}>
                Cancel campaign
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">Recipients</CardTitle>
          <Select value={recipientStatus ?? ALL} items={RECIPIENT_STATUS_ITEMS} onValueChange={(v) => { setRecipientStatus(v && v !== ALL ? (v as WhatsAppCampaignRecipientStatus) : undefined); setPage(1); }}>
            <SelectTrigger className="w-40" aria-label="Filter recipients by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(RECIPIENT_STATUS_ITEMS).map((key) => (
                <SelectItem key={key} value={key}>
                  {RECIPIENT_STATUS_ITEMS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {recipientsQuery.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : recipientsQuery.error ? (
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(recipientsQuery.error, "Failed to load recipients.")}
            </p>
          ) : !recipientsQuery.data || recipientsQuery.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No recipients match this filter.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Mobile</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message status</TableHead>
                    <TableHead>Failure reason</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Delivered</TableHead>
                    <TableHead>Read</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipientsQuery.data.items.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link href={`/dashboard/customers/${r.customer.leadId}`} className="text-primary hover:underline">
                          {r.customer.name}
                        </Link>
                      </TableCell>
                      <TableCell>{r.customer.mobile ?? "—"}</TableCell>
                      <TableCell>
                        <Badge className={RECIPIENT_STATUS_COLORS[r.status]}>{RECIPIENT_STATUS_LABELS[r.status]}</Badge>
                      </TableCell>
                      <TableCell>
                        {r.message ? <Badge className={MESSAGE_STATUS_COLORS[r.message.status as keyof typeof MESSAGE_STATUS_COLORS]}>{MESSAGE_STATUS_LABELS[r.message.status as keyof typeof MESSAGE_STATUS_LABELS] ?? r.message.status}</Badge> : "—"}
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-destructive">{r.failureReason ?? r.message?.errorMessage ?? "—"}</TableCell>
                      <TableCell>{r.message?.sentAt ? formatDateTime(r.message.sentAt) : "—"}</TableCell>
                      <TableCell>{r.message?.deliveredAt ? formatDateTime(r.message.deliveredAt) : "—"}</TableCell>
                      <TableCell>{r.message?.readAt ? formatDateTime(r.message.readAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <OrdersPagination pagination={recipientsQuery.data.pagination} onPageChange={setPage} disabled={recipientsQuery.isFetching} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
