import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/order-status";
import type { ReconciliationSummary } from "@/lib/api-client/types/reconciliation.types";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ReconciliationSummaryCards({ summary }: { summary: ReconciliationSummary }) {
  const money = (v: string) => formatMoney(v);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reconciliation summary</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <Stat label="Gross revenue" value={money(summary.grossOrderValue)} hint={`${summary.orderCount} orders`} />
        <Stat label="Net revenue" value={money(summary.netRevenue)} hint="Paid minus refunded" />
        <Stat label="Paid" value={money(summary.successfulPayments)} />
        <Stat label="Pending" value={money(summary.pendingPayments)} />
        <Stat label="Failed" value={money(summary.failedPayments)} />
        <Stat label="Refunded" value={money(summary.refundedAmount)} />
        <Stat label="Outstanding" value={money(summary.outstandingAmount)} />
        <Stat label="COD" value={money(summary.codValue)} hint={`${summary.codOrderCount} orders`} />
        <Stat label="Prepaid" value={money(summary.prepaidValue)} hint={`${summary.prepaidOrderCount} orders`} />
      </CardContent>
    </Card>
  );
}
