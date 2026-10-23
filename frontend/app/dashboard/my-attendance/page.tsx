"use client";

import { ShieldAlert } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { Card, CardContent } from "@/components/ui/card";
import { AttendanceCalendar } from "@/components/attendance/attendance-calendar";

export default function MyAttendancePage() {
  const role = useAuthStore((s) => s.user?.role);
  if (!role) return null;
  // The server limits a salesperson to their own records; other roles use the team calendar.
  if (role !== "SALESPERSON") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-14 text-center">
          <ShieldAlert className="size-9 text-muted-foreground/40" />
          <p className="font-heading text-lg font-medium">This page is for salespersons</p>
          <p className="text-sm text-muted-foreground">Managers and admins can use the Attendance Calendar.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-heading text-2xl font-extrabold">My Attendance</h1>
        <p className="text-sm text-muted-foreground">Your attendance history from your clock-ins. Only you can see this page.</p>
      </div>
      <AttendanceCalendar scope="self" />
    </div>
  );
}
