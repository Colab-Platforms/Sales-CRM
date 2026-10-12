"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { useSseStream } from "@/hooks/use-sse-stream";
import { attendanceApi } from "@/lib/api-client/endpoints/attendance.api";
import { attendanceKeys, myShiftQueryOptions } from "@/lib/api-client/queries/attendance.queries";
import { ShiftLimitToasts } from "@/components/attendance/work-status-widget";
import type { StatusEvent } from "@/lib/api-client/types/attendance.types";

const HEARTBEAT_EVERY_MS = 30_000;

/**
 * Mounted once in the dashboard shell. While a salesperson is clocked in it keeps the
 * presence stream open: while that stream is connected the server treats them as "here", and it
 * pushes their own status changes back so the header widget updates without polling.
 * Renders nothing; managers and admins have no shift of their own.
 */
export function AttendanceProvider() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const isSalesperson = user?.role === "SALESPERSON";
  const userId = user?.id;

  // Logging in does NOT start a shift: the salesperson presses "Clock in" in the header. Until then
  // (and after the server closes an abandoned shift) there is no stream and no heartbeat.
  const { data } = useQuery({ ...myShiftQueryOptions(), enabled: isSalesperson });
  const clockedIn = Boolean(data?.session && !data.session.endedAt);

  // The open stream alone can't prove the person is there (a sleeping laptop leaves the server-side
  // socket open for minutes), so the browser also sends a tiny heartbeat. No beat for ~2 minutes and
  // the server marks them Idle; the next beat after they return puts them back to Active.
  useEffect(() => {
    if (!isSalesperson || !clockedIn) return;
    const beat = () => {
      attendanceApi.heartbeat().catch(() => {
        // Offline - the server just won't see a beat, which is exactly what it should conclude.
      });
    };
    const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", beat);
    };
  }, [isSalesperson, clockedIn]);

  useSseStream<StatusEvent>(
    "/attendance/stream",
    (event) => {
      if (event.userId === userId) queryClient.invalidateQueries({ queryKey: attendanceKeys.me() });
    },
    isSalesperson && clockedIn,
  );

  return <ShiftLimitToasts />;
}
