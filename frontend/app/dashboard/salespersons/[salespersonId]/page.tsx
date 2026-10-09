"use client";

import { Suspense, use } from "react";
import { SalespersonReport } from "@/components/manager-dashboard/salesperson-report";
import { Skeleton } from "@/components/ui/skeleton";

export default function SalespersonReportPage(props: PageProps<"/dashboard/salespersons/[salespersonId]">) {
  const { salespersonId } = use(props.params);
  return (
    <Suspense fallback={<Skeleton className="h-96 rounded-lg" />}>
      <SalespersonReport salespersonId={salespersonId} />
    </Suspense>
  );
}
