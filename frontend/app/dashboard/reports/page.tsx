"use client";

import { ManagerSalesDashboard } from "@/components/manager-dashboard/manager-sales-dashboard";
import { ReportAccess } from "@/components/manager-dashboard/report-access";

export default function ReportsPage() {
  return (
    <ReportAccess>
      {(role) => (
        <ManagerSalesDashboard
          view="report"
          title="Reports"
          subtitle={
            role === "ADMIN"
              ? "Every team's salesperson-level performance, daily calls, productivity and conversion - filter, compare and export."
              : "Salesperson-level performance, daily calls, productivity and conversion - filter, compare and export."
          }
        />
      )}
    </ReportAccess>
  );
}
