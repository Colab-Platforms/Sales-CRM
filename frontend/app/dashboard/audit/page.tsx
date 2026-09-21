import { Suspense } from "react";
import { AuditView } from "@/components/audit/audit-view";
import { AuditTableSkeleton } from "@/components/audit/audit-table";

export default function AuditPage() {
  // AuditView reads the URL's search params, which requires a Suspense boundary.
  return (
    <Suspense fallback={<AuditTableSkeleton />}>
      <AuditView />
    </Suspense>
  );
}
