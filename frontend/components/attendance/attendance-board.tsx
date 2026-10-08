"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useNow } from "@/components/follow-ups/use-now";
import { useSseStream } from "@/hooks/use-sse-stream";
import { useAuthStore } from "@/stores/auth-store";
import {
  attendanceKeys,
  attendanceReportQueryOptions,
  teamStatusQueryOptions,
} from "@/lib/api-client/queries/attendance.queries";
import type {
  AttendanceSummary,
  StatusEvent,
  TeamMemberStatus,
} from "@/lib/api-client/types/attendance.types";
import {
  BREAK_LIMIT_MS,
  STATUS_DOT,
  STATUS_LABEL,
  formatClock,
  formatHours,
  tickSummary,
  todayInReportZone,
} from "@/lib/attendance";
import { cn } from "@/lib/utils";

function StatusCell({ member }: { member: TeamMemberStatus }) {
  const isOffline = member.status === "OFFLINE";
  return (
    <Badge 
      variant={isOffline ? "secondary" : "outline"} 
      className={cn("gap-1.5 px-2 py-0.5", !isOffline && "border-primary/20 bg-primary/5 text-primary")}
    >
      <span className={cn("size-2 rounded-full", STATUS_DOT[member.status])} />
      {STATUS_LABEL[member.status]}
    </Badge>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

function LiveBoard() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, dataUpdatedAt } = useQuery(teamStatusQueryOptions());
  const now = useNow(1000);

  // The server pushes a message the moment anyone on this board changes status; refetching the
  // snapshot keeps every total consistent with what the server just recorded.
  useSseStream<StatusEvent>(
    "/attendance/team/stream",
    () => queryClient.invalidateQueries({ queryKey: attendanceKeys.team() }),
    true,
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const sinceFetch = now - dataUpdatedAt;
    const serverNow = Date.parse(data.serverTime) + sinceFetch;
    return data.members.map((member) => {
      const open = member.shiftStartedAt !== null;
      const summary: AttendanceSummary | null =
        member.summary && open ? tickSummary(member.summary, member.status, sinceFetch) : member.summary;
      const inStatusMs = member.statusSince && open ? serverNow - Date.parse(member.statusSince) : null;
      return { member, summary, inStatusMs };
    });
  }, [data, now, dataUpdatedAt]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live team status</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <TableSkeleton />
        ) : isError ? (
          <p className="px-4 py-6 text-sm text-destructive">Could not load team status.</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No salespersons to show.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Salesperson</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>In status</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Break used</TableHead>
                <TableHead>Huddle</TableHead>
                <TableHead>Calling</TableHead>
                <TableHead>Productive</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ member, summary, inStatusMs }) => (
                <TableRow 
                  key={member.userId}
                  className={cn(
                    member.status === "ACTIVE" && "bg-emerald-50/50 hover:bg-emerald-50 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30",
                    (member.status === "TEA_BREAK" || member.status === "LUNCH_BREAK" || member.status === "BIO_BREAK") && "bg-amber-50/50 hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30"
                  )}
                >
                  <TableCell className="font-semibold">
                    <div className="flex items-center gap-2">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {member.name.slice(0, 2).toUpperCase()}
                      </div>
                      {member.name}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusCell member={member} />
                  </TableCell>
                  <TableCell className="tabular-nums font-medium text-muted-foreground">{inStatusMs === null ? "-" : formatClock(inStatusMs)}</TableCell>
                  <TableCell className="tabular-nums">{summary ? formatClock(summary.shiftElapsedMs) : "-"}</TableCell>
                  <TableCell
                    className={cn("tabular-nums", summary && summary.breakOverageMs > 0 && "font-semibold text-destructive")}
                  >
                    {summary ? (
                      <div className="flex items-center gap-2">
                        <span>{formatClock(summary.breakTotalMs)}</span>
                        <span className="text-xs text-muted-foreground">/ {formatClock(BREAK_LIMIT_MS)}</span>
                      </div>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{summary ? formatClock(summary.huddleMs) : "-"}</TableCell>
                  <TableCell className="tabular-nums">{summary ? formatClock(summary.callingMs) : "-"}</TableCell>
                  <TableCell className={cn("tabular-nums font-semibold", summary?.targetMet ? "text-emerald-600 dark:text-emerald-400" : "")}>
                    {summary ? formatClock(summary.productiveMs) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function timeOf(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
}

function DailyReport() {
  const [date, setDate] = useState(todayInReportZone);
  const { data, isLoading, isError } = useQuery(attendanceReportQueryOptions(date));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Daily report</CardTitle>
        <Input
          type="date"
          value={date}
          max={todayInReportZone()}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="w-44"
        />
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <TableSkeleton />
        ) : isError ? (
          <p className="px-4 py-6 text-sm text-destructive">Could not load the report.</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No salespersons to show.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Salesperson</TableHead>
                <TableHead>Login</TableHead>
                <TableHead>Logout</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Tea</TableHead>
                <TableHead>Lunch</TableHead>
                <TableHead>Bio</TableHead>
                <TableHead>Huddle</TableHead>
                <TableHead>Calling</TableHead>
                <TableHead>Idle</TableHead>
                <TableHead>Productive</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => {
                const s = row.summary;
                return (
                  <TableRow key={row.userId}>
                    <TableCell className="font-semibold">{row.name}</TableCell>
                    <TableCell>{timeOf(row.firstLoginAt)}</TableCell>
                    <TableCell>{row.sessions.some((x) => !x.endedAt) ? "Working" : timeOf(row.lastLogoutAt)}</TableCell>
                    <TableCell className="tabular-nums">{s ? formatHours(s.shiftElapsedMs) : "-"}</TableCell>
                    <TableCell className="tabular-nums">{s ? formatHours(s.teaMs) : "-"}</TableCell>
                    <TableCell className="tabular-nums">{s ? formatHours(s.lunchMs) : "-"}</TableCell>
                    <TableCell
                      className={cn("tabular-nums", s && s.breakOverageMs > 0 && "font-semibold text-destructive")}
                      title={s && s.breakOverageMs > 0 ? `Breaks total ${formatHours(s.breakTotalMs)} - over the 1h allowance` : undefined}
                    >
                      {s ? formatHours(s.bioMs) : "-"}
                    </TableCell>
                    <TableCell className="tabular-nums">{s ? formatHours(s.huddleMs) : "-"}</TableCell>
                    <TableCell className="tabular-nums">{s ? formatHours(s.callingMs) : "-"}</TableCell>
                    <TableCell className="tabular-nums">{s ? formatHours(s.idleMs) : "-"}</TableCell>
                    <TableCell
                      className={cn(
                        "font-semibold tabular-nums",
                        s && (s.targetMet ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300"),
                      )}
                    >
                      {s ? `${formatHours(s.productiveMs)} / ${formatHours(s.productiveTargetMs)}` : "-"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function AttendanceBoard() {
  const role = useAuthStore((s) => s.user?.role);
  if (role !== "ADMIN" && role !== "MANAGER") {
    return <p className="text-sm text-muted-foreground">Attendance is available to managers and admins.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-extrabold">Attendance</h1>
        <p className="text-sm text-muted-foreground">
          Live status, shift timers and productive hours.
          {role === "MANAGER" ? " Showing your direct reports." : " Showing all salespersons."}
        </p>
      </div>
      <LiveBoard />
      <DailyReport />
    </div>
  );
}
