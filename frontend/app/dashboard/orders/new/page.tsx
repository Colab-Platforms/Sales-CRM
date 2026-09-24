import { Suspense } from "react";
import { NewOrderView } from "@/components/orders/booking/new-order-view";

export default function NewOrderPage() {
  return (
    <Suspense fallback={null}>
      <NewOrderView />
    </Suspense>
  );
}
