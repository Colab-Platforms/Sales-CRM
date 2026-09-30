import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { formatDateTime } from "@/lib/order-status";
import { LEAD_PRIORITY_LABELS } from "@/lib/customer-status";
import { CustomerStatusBadge } from "./customer-status-badge";
import type { Customer360 } from "@/lib/api-client/types/customers.types";

export function CustomerProfileCard({ customer }: { customer: Customer360 }) {
  const { profile } = customer;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-xl">{profile.name}</CardTitle>
          <CustomerStatusBadge status={profile.workingStatus} />
          <Badge variant="outline">{LEAD_PRIORITY_LABELS[profile.priority]}</Badge>
          {customer.currentOrderStatus ? <OrderStatusBadge status={customer.currentOrderStatus} /> : null}
        </div>
      </CardHeader>
      <CardContent>
        <DetailGrid>
          <DetailField label="Mobile">{profile.mobile ?? "—"}</DetailField>
          <DetailField label="Email">{profile.email ?? "—"}</DetailField>
          <DetailField label="Lead number">{profile.leadNumber}</DetailField>
          <DetailField label="Lead owner">{profile.owner?.name ?? "—"}</DetailField>
          <DetailField label="Source">{profile.source?.name ?? "—"}</DetailField>
          <DetailField label="Customer since">{formatDateTime(profile.createdAt)}</DetailField>
          <DetailField label="Last activity">{formatDateTime(profile.lastActivityAt)}</DetailField>
          <DetailField label="Last contacted">{formatDateTime(profile.lastContactedAt)}</DetailField>
          <DetailField label="Total orders">{customer.paymentSummary.orderCount}</DetailField>
        </DetailGrid>
        {customer.shopifyCustomer ? (
          <p className="mt-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Live from Shopify:</span> {customer.shopifyCustomer.numberOfOrders ?? 0} orders,{" "}
            {customer.shopifyCustomer.amountSpent ? `${customer.shopifyCustomer.amountSpent.currencyCode} ${customer.shopifyCustomer.amountSpent.amount} spent` : "spend not available"}
          </p>
        ) : customer.shopifyError ? (
          <p className="mt-4 text-xs text-muted-foreground">Live Shopify details unavailable: {customer.shopifyError}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
