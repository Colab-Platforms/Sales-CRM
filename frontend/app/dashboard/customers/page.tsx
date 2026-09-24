import { Suspense } from "react";
import { CustomersListView } from "@/components/customers/customers-list-view";
import { CustomersTableSkeleton } from "@/components/customers/customers-table";

export default function CustomersPage() {
  // CustomersListView reads the URL's search params, which requires a Suspense boundary.
  return (
    <Suspense fallback={<CustomersTableSkeleton />}>
      <CustomersListView />
    </Suspense>
  );
}
