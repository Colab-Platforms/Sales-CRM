import { Suspense } from "react";
import { AbandonedLeadsView } from "@/components/abandonment/abandoned-leads-view";
import { AbandonmentTableSkeleton } from "@/components/abandonment/abandonment-table";

export default function AbandonedLeadsPage() {
  // AbandonedLeadsView reads the URL's search params, which requires a Suspense boundary.
  return (
    <Suspense fallback={<AbandonmentTableSkeleton />}>
      <AbandonedLeadsView />
    </Suspense>
  );
}
