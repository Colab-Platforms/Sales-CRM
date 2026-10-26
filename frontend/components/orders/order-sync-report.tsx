"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { getErrorMessage } from "@/lib/api-client/client";
import { ordersApi } from "@/lib/api-client/endpoints/orders.api";
import type { SyncCategory } from "@/lib/api-client/types/orders.types";
import { useAuthStore } from "@/stores/auth-store";

// READ-ONLY: which CRM orders are out of sync with Shopify, and why. Admin and Manager only (the server enforces it). Nothing is changed from here - open an order and use Sync / Update from CRM.
const LABEL: Record<SyncCategory, string> = {
  SYNCED: "Already synchronized",
  SAFE_CUSTOMER: "Safe customer link / name repair",
  SAFE_ADDRESS: "Safe address update",
  FINANCIAL: "Financial mismatch (manual review)",
  CONFLICT: "Payment / refund / fulfilment / shipment conflict (manual review)",
  AMBIGUOUS_CUSTOMER: "Customer match failed or ambiguous",
};

export function OrderSyncReport() {
  const role = useAuthStore((s) => s.user?.role);
  const allowed = role === "ADMIN" || role === "MANAGER";
  const [filter, setFilter] = useState<SyncCategory | "">("");
  const q = useQuery({ queryKey: ["orders", "sync-report"], queryFn: () => ordersApi.syncReport(), enabled: allowed, staleTime: 60_000 });
  if (!allowed) return <div role="alert" className="py-10 text-center text-sm text-muted-foreground">This report is available to Admin and Manager users only.</div>;
  const r = q.data;
  const rows = (r?.items ?? []).filter((i) => !filter || i.category === filter);
  return (
    <div className="space-y-4" data-testid="sync-report">
      <PageHeader title="Orders out of sync with Shopify" description="Read-only. Each CRM order that was pushed to Shopify, compared on totals, customer and shipping address." />
      {q.isLoading ? <p className="text-sm text-muted-foreground">Comparing the CRM with Shopify… (this reads every pushed order)</p> : null}
      {q.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(q.error, "Could not load the report.")} <Button size="sm" variant="outline" onClick={() => void q.refetch()}>Retry</Button></p> : null}
      {r ? (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm">
              {(Object.keys(LABEL) as SyncCategory[]).map((c) => (
                <button key={c} type="button" onClick={() => setFilter(filter === c ? "" : c)} className={`rounded-md border px-3 py-1 text-left ${filter === c ? "border-primary" : ""}`} data-testid={`sync-count-${c}`}>
                  <span className="block text-lg font-semibold tabular-nums">{r.counts[c]}</span>
                  <span className="text-xs text-muted-foreground">{LABEL[c]}</span>
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2">
                <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value as SyncCategory | "")} aria-label="Filter by category">
                  <option value="">All out-of-sync orders</option>
                  {(Object.keys(LABEL) as SyncCategory[]).filter((c) => c !== "SYNCED").map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
                </NativeSelect>
                <Button size="sm" variant="outline" onClick={() => void ordersApi.syncReport(true).then(() => q.refetch())} disabled={q.isFetching}>Refresh</Button>
              </div>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">{r.compared} orders compared · generated {new Date(r.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {r.note}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead><TableHead>Customer in Shopify</TableHead><TableHead className="text-right">CRM</TableHead><TableHead className="text-right">Shopify</TableHead><TableHead className="text-right">Diff</TableHead><TableHead>Payment / fulfilment</TableHead><TableHead>Category and proposed repair</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => (
                <TableRow key={i.crmOrderId}>
                  <TableCell><Link className="font-medium hover:underline" href={`/dashboard/orders/${i.crmOrderId}`}>{i.orderName ?? i.crmOrderNumber}</Link><div className="text-xs text-muted-foreground">{i.crmOrderNumber}</div></TableCell>
                  <TableCell>{i.customerAssociation}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.crmTotal}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.shopifyTotal}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.difference}</TableCell>
                  <TableCell className="text-xs">{i.paymentStatus} / {i.fulfilment?.toLowerCase() ?? "-"}</TableCell>
                  <TableCell className="max-w-md whitespace-normal text-xs"><div className="font-medium">{i.categoryLabel}</div><div className="text-muted-foreground">{i.proposedRepair}</div></TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">Nothing out of sync in this view.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </>
      ) : null}
    </div>
  );
}
