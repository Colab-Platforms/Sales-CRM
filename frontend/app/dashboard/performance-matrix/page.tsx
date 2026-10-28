"use client";

import { ReportAccess } from "@/components/manager-dashboard/report-access";
import { PerformanceMatrixPage } from "@/components/performance-matrix/matrix-page";

export default function PerformanceMatrixRoute() {
  return <ReportAccess>{(role) => <PerformanceMatrixPage role={role} />}</ReportAccess>;
}
