"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { useWhatsAppTemplates } from "@/hooks/useWhatsAppTemplates";
import { getErrorMessage } from "@/lib/api-client/client";
import { useSyncTemplatesMutation } from "@/lib/api-client/mutations/whatsapp-templates.mutations";
import { useAuthStore } from "@/stores/auth-store";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";
import { TemplateDetailDialog } from "./template-detail-dialog";
import { TemplateFormDialog } from "./template-form-dialog";
import { TemplatesFiltersBar, type TemplateFilters } from "./templates-filters";
import { TemplatesTable, TemplatesTableSkeleton } from "./templates-table";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;

export function WhatsAppTemplatesView() {
  const user = useAuthStore((s) => s.user);
  const canManage = user?.role === "ADMIN";

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchText, setSearchText] = useState("");
  const [filters, setFilters] = useState<TemplateFilters>({});
  const [selected, setSelected] = useState<WhatsAppTemplate | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WhatsAppTemplate | undefined>(undefined);

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

  function handleFilterChange(patch: Partial<TemplateFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }

  function handleClear() {
    setFilters({});
    setSearchText("");
    setSearch("");
    setPage(1);
  }

  const hasActiveFilters = Boolean(search || filters.provider || filters.status || filters.category || filters.language);

  const { data, isLoading, isFetching, error } = useWhatsAppTemplates({
    page,
    pageSize: PAGE_SIZE,
    search: search || undefined,
    ...filters,
  });

  const syncMutation = useSyncTemplatesMutation();
  function handleSync(provider?: "META") {
    syncMutation.mutate(provider, {
      onSuccess: (result) => {
        if (!result.supported) {
          toast.info(result.reason ?? `${result.provider} does not support template sync.`);
        } else {
          toast.success(`Synced: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged.`);
        }
      },
      onError: (err) => toast.error(getErrorMessage(err, "Sync failed.")),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp Templates</h1>
          <p className="text-sm text-muted-foreground">Manage local drafts and templates synced from your configured provider.</p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => handleSync()} disabled={syncMutation.isPending}>
              <RefreshCw data-icon="inline-start" className={syncMutation.isPending ? "animate-spin" : undefined} />
              Sync from provider
            </Button>
            {/* Meta templates come from Settings -> WhatsApp Config, not the env-configured provider; only an APPROVED synced
                Meta template can be sent to a conversation that is on Meta. */}
            <Button variant="outline" onClick={() => handleSync("META")} disabled={syncMutation.isPending}>
              <RefreshCw data-icon="inline-start" className={syncMutation.isPending ? "animate-spin" : undefined} />
              Sync Meta templates
            </Button>
            <Button
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              <Plus data-icon="inline-start" />
              New template
            </Button>
          </div>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-6">
          <TemplatesFiltersBar
            searchText={searchText}
            onSearchChange={handleSearchChange}
            filters={filters}
            onFilterChange={handleFilterChange}
            onClear={handleClear}
            hasActiveFilters={hasActiveFilters}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <TemplatesTableSkeleton />
          ) : error ? (
            <p role="alert" className="py-10 text-center text-sm text-destructive">
              {error}
            </p>
          ) : (
            <>
              <TemplatesTable items={data?.items ?? []} isFetching={isFetching} onSelect={setSelected} />
              {data ? <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={isFetching} /> : null}
            </>
          )}
        </CardContent>
      </Card>

      <TemplateDetailDialog
        template={selected}
        onOpenChange={(open) => !open && setSelected(null)}
        canManage={canManage}
        onEdit={(t) => {
          setSelected(null);
          setEditing(t);
          setFormOpen(true);
        }}
      />

      {canManage ? <TemplateFormDialog open={formOpen} onOpenChange={setFormOpen} template={editing} /> : null}
    </div>
  );
}
