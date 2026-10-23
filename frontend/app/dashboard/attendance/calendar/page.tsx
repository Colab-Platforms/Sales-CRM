"use client";

import { ReportAccess } from "@/components/manager-dashboard/report-access";
import { AttendanceCalendar } from "@/components/attendance/attendance-calendar";

export default function AttendanceCalendarPage() {
  return (
    <ReportAccess>
      {(role) => (
        <div className="space-y-5">
          <div>
            <h1 className="font-heading text-2xl font-extrabold">Attendance Calendar</h1>
            <p className="text-sm text-muted-foreground">
              Month-by-month attendance from real clock-ins.{role === "MANAGER" ? " Showing your direct reports." : " Showing all salespersons."}
            </p>
          </div>
          <AttendanceCalendar scope="team" />
        </div>
      )}
    </ReportAccess>
  );
}
