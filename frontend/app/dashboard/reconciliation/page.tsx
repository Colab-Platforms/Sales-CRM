import { Suspense } from "react";
import { ReconciliationView } from "@/components/reconciliation/reconciliation-view";
import { ReconciliationTableSkeleton } from "@/components/reconciliation/reconciliation-table";

export default function ReconciliationPage() {
  // ReconciliationView reads the URL's search params, which requires a Suspense boundary.
  return (
    <Suspense fallback={<ReconciliationTableSkeleton />}>
      <ReconciliationView />
    </Suspense>
  );
}
