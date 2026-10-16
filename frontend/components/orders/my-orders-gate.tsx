"use client";

import Link from "next/link";
import { useAuthStore } from "@/stores/auth-store";
import { MyOrdersView } from "./my-orders-view";

/** "My Orders" is for Salespersons only (the API refuses everyone else too, so hiding the nav entry is not the only protection). */
export const canViewMyOrders = (role: string | undefined) => role === "SALESPERSON";

export function MyOrdersGate() {
  const role = useAuthStore((s) => s.user?.role);
  if (!canViewMyOrders(role)) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center" data-testid="my-orders-forbidden">
        <p className="text-base font-semibold">My Orders is only available to Salespersons.</p>
        <p className="text-sm text-muted-foreground">Use the Orders page to see every order you are allowed to view.</p>
        <Link href="/dashboard/orders" className="text-sm font-medium text-primary hover:underline">Go to Orders</Link>
      </div>
    );
  }
  return <MyOrdersView />;
}
