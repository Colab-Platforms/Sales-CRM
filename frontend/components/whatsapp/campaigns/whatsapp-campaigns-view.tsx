"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Copy, MoreVertical, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { getErrorMessage } from "@/lib/api-client/client";
import { useDuplicateCampaignMutation } from "@/lib/api-client/mutations/whatsapp-campaigns.mutations";
import { whatsappCampaignListQueryOptions } from "@/lib/api-client/queries/whatsapp-campaigns.queries";
import type { WhatsAppCampaignProvider, WhatsAppCampaignStatus } from "@/lib/api-client/types/whatsapp-campaigns.types";
import { CAMPAIGN_STATUS_COLORS, CAMPAIGN_STATUS_LABELS } from "@/lib/whatsapp-campaign-status";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { formatDateTime } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";

const PAGE_SIZE = 20;
const ALL = "ALL";
const STATUS_ITEMS: Record<string, string> = { [ALL]: "All statuses", ...CAMPAIGN_STATUS_LABELS };
const PROVIDER_ITEMS: Record<string, string> = { [ALL]: "All providers", ...PROVIDER_LABELS };
const SEARCH_DEBOUNCE_MS = 350;
const CANCELABLE = new Set<WhatsAppCampaignStatus>(["DRAFT", "SCHEDULED", "RUNNING"]);

export function WhatsAppCampaignsView() {
  const user = useAuthStore((s) => s.user);
  const canCreate = user?.role === "ADMIN";
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<WhatsAppCampaignStatus | undefined>(undefined);
  const [provider, setProvider] = useState<WhatsAppCampaignProvider | undefined>(undefined);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");

  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  function handleSearchChange(text: string) {
    setSearchText(text);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(text);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
  }

  const hasActiveFilters = Boolean(status || provider || search || createdFrom || createdTo);
  function clearFilters() {
    setStatus(undefined);
    setProvider(undefined);
    setSearchText("");
    setSearch("");
    setCreatedFrom("");
    setCreatedTo("");
    setPage(1);
  }

  const query = useQuery({
    ...whatsappCampaignListQueryOptions({
      page,
      pageSize: PAGE_SIZE,
      status,
      provider,
      search: search || undefined,
      createdFrom: createdFrom ? new Date(createdFrom).toISOString() : undefined,
      createdTo: createdTo ? new Date(`${createdTo}T23:59:59`).toISOString() : undefined,
    }),
    enabled: Boolean(user),
  });

  const duplicateMutation = useDuplicateCampaignMutation();
  function handleDuplicate(id: string) {
    duplicateMutation.mutate(id, {
      onSuccess: () => toast.success("Campaign duplicated as a new draft."),
      onError: (err) => toast.error(getErrorMessage(err, "Could not duplicate the campaign.")),
    });
  }

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
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-[minmax(0,1fr)_repeat(4,auto)] sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-search" className="text-xs text-muted-foreground">
              Search by name
            </Label>
            <Input id="campaign-search" value={searchText} onChange={(e) => handleSearchChange(e.target.value)} placeholder="Search campaigns…" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={status ?? ALL} items={STATUS_ITEMS} onValueChange={(v) => { setStatus(v && v !== ALL ? (v as WhatsAppCampaignStatus) : undefined); setPage(1); }}>
              <SelectTrigger className="w-40" aria-label="Filter by status">
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
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <Select value={provider ?? ALL} items={PROVIDER_ITEMS} onValueChange={(v) => { setProvider(v && v !== ALL ? (v as WhatsAppCampaignProvider) : undefined); setPage(1); }}>
              <SelectTrigger className="w-40" aria-label="Filter by provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(PROVIDER_ITEMS).map((key) => (
                  <SelectItem key={key} value={key}>
                    {PROVIDER_ITEMS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-created-from" className="text-xs text-muted-foreground">
              Created from
            </Label>
            <Input id="campaign-created-from" type="date" value={createdFrom} max={createdTo || undefined} onChange={(e) => { setCreatedFrom(e.target.value); setPage(1); }} className="w-36" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-created-to" className="text-xs text-muted-foreground">
              Created to
            </Label>
            <Input id="campaign-created-to" type="date" value={createdTo} min={createdFrom || undefined} onChange={(e) => { setCreatedTo(e.target.value); setPage(1); }} className="w-36" />
          </div>
          {hasActiveFilters ? (
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters} className="sm:col-span-full sm:w-fit">
              <X data-icon="inline-start" />
              Clear filters
            </Button>
          ) : null}
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
            <p className="py-10 text-center text-sm text-muted-foreground">{hasActiveFilters ? "No campaigns match these filters." : "No campaigns yet - create one to get started."}</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Recipients</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Delivered</TableHead>
                    <TableHead>Read</TableHead>
                    <TableHead>Failed</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Creator</TableHead>
                    {canCreate ? <TableHead className="text-right">Actions</TableHead> : null}
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
                      <TableCell className="text-muted-foreground">{c.template ? (PROVIDER_LABELS[c.template.provider] ?? c.template.provider) : "—"}</TableCell>
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
                      <TableCell>{c.scheduledAt ? formatDateTime(c.scheduledAt) : "—"}</TableCell>
                      <TableCell>{c.createdBy?.name ?? "—"}</TableCell>
                      {canCreate ? (
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`} />}>
                              <MoreVertical />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem render={<Link href={`/dashboard/whatsapp/campaigns/${c.id}`} />}>View</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleDuplicate(c.id)} className="gap-2">
                                <Copy className="size-3.5" />
                                Duplicate
                              </DropdownMenuItem>
                              {CANCELABLE.has(c.status) ? (
                                <DropdownMenuItem render={<Link href={`/dashboard/whatsapp/campaigns/${c.id}`} />}>{c.status === "DRAFT" ? "Edit / Cancel" : "Cancel"}</DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      ) : null}
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
