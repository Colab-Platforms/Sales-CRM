import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/order-status";
import type { CustomerPaymentSummary } from "@/lib/api-client/types/customers.types";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function CustomerPaymentSummaryCard({ summary, currency }: { summary: CustomerPaymentSummary; currency: string }) {
  const money = (v: string) => formatMoney(v, currency);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Total order value" value={money(summary.totalOrderValue)} hint={`${summary.orderCount} orders`} />
          <Stat label="Paid" value={money(summary.totalPaid)} hint={`${summary.successfulPaymentCount} successful`} />
          <Stat label="Pending" value={money(summary.totalPending)} hint={`${summary.pendingPaymentCount} pending`} />
          <Stat label="Failed" value={money(summary.totalFailed)} hint={`${summary.failedPaymentCount} failed`} />
          <Stat label="Refunded" value={money(summary.totalRefunded)} hint={`${summary.refundedPaymentCount} refunded`} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:w-fit sm:grid-cols-2">
          <Stat label="COD" value={money(summary.codValue)} hint={`${summary.codOrderCount} orders`} />
          <Stat label="Prepaid" value={money(summary.prepaidValue)} hint={`${summary.prepaidOrderCount} orders`} />
        </div>
      </CardContent>
    </Card>
  );
}
