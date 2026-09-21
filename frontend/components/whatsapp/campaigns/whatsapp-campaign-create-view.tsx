"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CustomersFiltersBar, type CustomersFilters } from "@/components/customers/customers-filters";
import { useWhatsAppTemplates } from "@/hooks/useWhatsAppTemplates";
import { useOrderFilterOptions } from "@/hooks/useOrders";
import { getErrorMessage } from "@/lib/api-client/client";
import { usePreviewTemplateMutation } from "@/lib/api-client/mutations/whatsapp-messaging.mutations";
import { usePreviewAudienceMutation, useCreateCampaignMutation } from "@/lib/api-client/mutations/whatsapp-campaigns.mutations";
import type { AudienceFilters } from "@/lib/api-client/types/whatsapp-campaigns.types";
import { useAuthStore } from "@/stores/auth-store";

function dayBoundary(day: string | undefined, time: string): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T${time}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toAudienceFilters(search: string, filters: CustomersFilters): AudienceFilters {
  return {
    search: search || undefined,
    segment: filters.segment,
    ownerId: filters.ownerId,
    hasOrders: filters.hasOrders === undefined ? undefined : filters.hasOrders === "true",
    paymentStatus: filters.paymentStatus,
    shipmentStatus: filters.shipmentStatus,
    nbaAction: filters.nbaAction,
    nbaPriority: filters.nbaPriority,
    dateFrom: dayBoundary(filters.dateFrom, "00:00:00"),
    dateTo: dayBoundary(filters.dateTo, "23:59:59.999"),
  };
}

export function WhatsAppCampaignCreateView() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const showOwner = user !== null && user.role !== "SALESPERSON";
  const { salespeople } = useOrderFilterOptions(showOwner);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [searchText, setSearchText] = useState("");
  const [filters, setFilters] = useState<CustomersFilters>({});
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);

  const dateRangeInvalid = Boolean(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo);
  const audienceFilters = useMemo(() => toAudienceFilters(searchText, filters), [searchText, filters]);

  const templatesQuery = useWhatsAppTemplates({ page: 1, pageSize: 100, status: "APPROVED" });
  const templates = templatesQuery.data?.items ?? [];
  const selectedTemplate = templates.find((t) => t.id === templateId);

  const previewMutation = usePreviewAudienceMutation();
  const variablePreviewMutation = usePreviewTemplateMutation();
  const createMutation = useCreateCampaignMutation();

  function handlePreview() {
    previewMutation.mutate(audienceFilters, {
      onError: (err) => toast.error(getErrorMessage(err, "Failed to preview audience.")),
      onSuccess: (result) => {
        // A quick, honest example of what the first matched customer would actually receive -
        // reuses E7.3's own preview endpoint, never a second variable-resolution implementation.
        if (templateId && result.sample[0]) {
          variablePreviewMutation.mutate({ leadId: result.sample[0].leadId, templateId });
        }
      },
    });
  }

  function handleCreate() {
    if (!name.trim() || !templateId) return;
    createMutation.mutate(
      { name: name.trim(), description: description.trim() || undefined, templateId, filters: audienceFilters },
      {
        onSuccess: (campaign) => {
          toast.success("Campaign saved as a draft.");
          router.push(`/dashboard/whatsapp/campaigns/${campaign.id}`);
        },
        onError: (err) => toast.error(getErrorMessage(err, "Failed to create campaign.")),
      },
    );
  }

  const preview = previewMutation.data;
  const canCreate = name.trim().length > 0 && Boolean(templateId) && !createMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New WhatsApp Campaign</h1>
        <p className="text-sm text-muted-foreground">Filter an audience, pick an approved template, preview it, then save as a draft to review before launching.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Campaign name</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="campaign-name">Name</Label>
            <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} placeholder="e.g. Diwali order reminders" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="campaign-description">Description (optional)</Label>
            <Input id="campaign-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} placeholder="Internal note about this campaign's purpose" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Audience filters</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomersFiltersBar
            searchText={searchText}
            onSearchChange={setSearchText}
            filters={filters}
            onFilterChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
            onClear={() => { setFilters({}); setSearchText(""); }}
            hasActiveFilters={Boolean(searchText || Object.keys(filters).length > 0)}
            owners={salespeople}
            showOwner={showOwner}
            dateRangeInvalid={dateRangeInvalid}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Recipient preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={handlePreview} disabled={previewMutation.isPending || dateRangeInvalid}>
            {previewMutation.isPending ? "Checking..." : "Preview audience"}
          </Button>
          {preview ? (
            <div className="space-y-2 text-sm">
              <p>
                <span className="font-medium">{preview.count}</span> customer{preview.count === 1 ? "" : "s"} will receive this campaign
                {preview.excludedNoMobile > 0 ? ` (${preview.excludedNoMobile} matched but have no WhatsApp number on file, and are excluded)` : ""}.
              </p>
              {preview.sample.length > 0 ? (
                <ul className="list-inside list-disc text-muted-foreground">
                  {preview.sample.map((s) => (
                    <li key={s.leadId}>
                      {s.name} — {s.mobile}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Approved template</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={templateId} items={Object.fromEntries(templates.map((t) => [t.id, `${t.name} (${t.provider})`]))} onValueChange={(v) => setTemplateId(v ?? undefined)} disabled={templatesQuery.isLoading}>
            <SelectTrigger className="w-full sm:w-96" aria-label="Approved template">
              <SelectValue placeholder={templatesQuery.isLoading ? "Loading templates..." : "Select an approved template"} />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} ({t.provider})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {templates.length === 0 && !templatesQuery.isLoading ? <p className="mt-2 text-sm text-muted-foreground">No APPROVED templates exist yet - create and approve one first.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Variable preview</CardTitle>
        </CardHeader>
        <CardContent>
          {variablePreviewMutation.isPending ? (
            <p className="text-sm text-muted-foreground">Resolving an example message...</p>
          ) : variablePreviewMutation.data ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{variablePreviewMutation.data.resolvedBody}</div>
          ) : (
            <p className="text-sm text-muted-foreground">Preview the audience with a template selected to see an example resolved message here.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">6. Review</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <span className="text-muted-foreground">Name:</span> {name || "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Template:</span> {selectedTemplate?.name ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">Audience:</span> {preview ? `${preview.count} customers` : "Not yet previewed"}
          </p>
          <p className="text-muted-foreground">Sending time (Send Now vs. Schedule) is chosen when you launch, from the campaign&rsquo;s detail page.</p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleCreate} disabled={!canCreate}>
          {createMutation.isPending ? "Saving..." : "Save as draft"}
        </Button>
        <Link href="/dashboard/whatsapp/campaigns" className={buttonVariants({ variant: "outline" })}>
          Cancel
        </Link>
      </div>
    </div>
  );
}
