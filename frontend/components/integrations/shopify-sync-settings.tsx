"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/api-client/client";
import { shopifyCrmOrderSyncQueryOptions } from "@/lib/api-client/queries/integrations.queries";
import { useSetShopifyCrmOrderSyncMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSyncStatus } from "./shopify-sync-format";

// Admin Panel -> Integrations -> Shopify. The switch is only a view of the database setting: the backend decides, per order, when it is created.
export function ShopifySyncSettings() {
  const role = useAuthStore((s) => s.user?.role);
  const setting = useQuery({ ...shopifyCrmOrderSyncQueryOptions(), enabled: role === "ADMIN" });
  const save = useSetShopifyCrmOrderSyncMutation();

  if (role !== "ADMIN") {
    return <p className="text-sm text-muted-foreground">Only an Admin can manage Shopify integration settings.</p>;
  }

  const enabled = setting.data?.enabled ?? true;
  const status = formatSyncStatus(setting.data);

  const toggle = () => {
    if (!setting.data || save.isPending) return;
    save.mutate(!enabled, {
      onSuccess: (saved) => toast.success(`Shopify sync for CRM-created orders is now ${saved.enabled ? "ON" : "OFF"}.`),
      onError: (error) => toast.error(getErrorMessage(error)),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Shopify" description="Integrations · how orders created inside the CRM are handled for Shopify." />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Shopify Sync for CRM-Created Orders</CardTitle>
            {setting.isLoading ? (
              <Skeleton className="h-6 w-16" />
            ) : (
              <Badge variant={enabled ? "default" : "secondary"} data-testid="shopify-sync-status">
                {status.badge}
              </Badge>
            )}
          </div>
          <CardDescription>
            Applies to COD and prepaid orders created in the CRM by Telecallers, Managers and Admins. Orders that come from Shopify, and Shiprocket shipping, payment and tracking, are never affected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {setting.isError ? (
            <p className="text-sm text-destructive">{getErrorMessage(setting.error)}</p>
          ) : (
            <label className="flex items-center gap-3 text-sm">
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Shopify Sync for CRM-Created Orders"
                disabled={!setting.data || save.isPending}
                onClick={toggle}
                data-testid="shopify-sync-toggle"
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${enabled ? "bg-primary" : "bg-muted"}`}
              >
                <span className={`inline-block size-5 rounded-full bg-background shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
              <span>{save.isPending ? "Saving…" : enabled ? "ON" : "OFF"}</span>
            </label>
          )}
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{status.on}</li>
            <li>{status.off}</li>
            <li>The choice is saved on each order when it is created. Changing this setting never changes orders that already exist.</li>
            {setting.data && <li>{status.updated}</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
