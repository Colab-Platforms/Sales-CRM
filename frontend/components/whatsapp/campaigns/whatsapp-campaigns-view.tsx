"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappCampaignListQueryOptions } from "@/lib/api-client/queries/whatsapp-campaigns.queries";
import type { WhatsAppCampaignStatus } from "@/lib/api-client/types/whatsapp-campaigns.types";
import { CAMPAIGN_STATUS_COLORS, CAMPAIGN_STATUS_LABELS } from "@/lib/whatsapp-campaign-status";
import { formatDateTime } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";

const PAGE_SIZE = 20;
const ALL = "ALL";
const STATUS_ITEMS: Record<string, string> = { [ALL]: "All statuses", ...CAMPAIGN_STATUS_LABELS };

export function WhatsAppCampaignsView() {
  const user = useAuthStore((s) => s.user);
  const canCreate = user?.role === "ADMIN";
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<WhatsAppCampaignStatus | undefined>(undefined);

  const query = useQuery({ ...whatsappCampaignListQueryOptions({ page, pageSize: PAGE_SIZE, status }), enabled: Boolean(user) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp Campaigns</h1>
          <p className="text-sm text-muted-foreground">Send an approved WhatsApp template to a filtered group of customers, in controlled batches.</p>
        </div>
        {canCreate ? (
          <Link href="/dashboard/whatsapp/campaigns/new" className={buttonVariants({})}>
            <Plus data-icon="inline-start" />
            New campaign
          </Link>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-6">
          <Select value={status ?? ALL} items={STATUS_ITEMS} onValueChange={(v) => { setStatus(v && v !== ALL ? (v as WhatsAppCampaignStatus) : undefined); setPage(1); }}>
            <SelectTrigger className="w-48" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(STATUS_ITEMS).map((key) => (
                <SelectItem key={key} value={key}>
                  {STATUS_ITEMS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {query.isPending ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading campaigns">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : query.error ? (
            <p role="alert" className="py-10 text-center text-sm text-destructive">
              {getErrorMessage(query.error, "Failed to load campaigns.")}
            </p>
          ) : !query.data || query.data.items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No campaigns yet.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Recipients</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Delivered</TableHead>
                    <TableHead>Read</TableHead>
                    <TableHead>Failed</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Creator</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.items.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link href={`/dashboard/whatsapp/campaigns/${c.id}`} className="font-medium text-primary hover:underline">
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell>{c.template?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge className={CAMPAIGN_STATUS_COLORS[c.status]}>{CAMPAIGN_STATUS_LABELS[c.status]}</Badge>
                      </TableCell>
                      <TableCell>{c.stats.totalRecipients}</TableCell>
                      <TableCell>{c.stats.sent}</TableCell>
                      <TableCell>{c.stats.delivered}</TableCell>
                      <TableCell>{c.stats.read}</TableCell>
                      <TableCell>{c.stats.failed}</TableCell>
                      <TableCell>{formatDateTime(c.createdAt)}</TableCell>
                      <TableCell>{c.createdBy?.name ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <OrdersPagination pagination={query.data.pagination} onPageChange={setPage} disabled={query.isFetching} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
