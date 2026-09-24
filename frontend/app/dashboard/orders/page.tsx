import { Suspense } from "react";
import { OrdersListView } from "@/components/orders/orders-list-view";
import { OrdersTableSkeleton } from "@/components/orders/orders-table";

export default function OrdersPage() {
  // OrdersListView reads the URL's search params, which requires a Suspense boundary.
  return (
    <Suspense fallback={<OrdersTableSkeleton />}>
      <OrdersListView />
    </Suspense>
  );
}
