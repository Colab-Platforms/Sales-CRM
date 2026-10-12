"use client";

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, LogIn, LogOut, Timer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNow } from "@/components/follow-ups/use-now";
import { useAuthStore } from "@/stores/auth-store";
import { getErrorMessage } from "@/lib/api-client/client";
import { useEndShiftMutation, useSetWorkStatusMutation, useStartShiftMutation } from "@/lib/api-client/mutations/attendance.mutations";
import { myShiftQueryOptions } from "@/lib/api-client/queries/attendance.queries";
import type { ManualWorkStatus } from "@/lib/api-client/types/attendance.types";
import {
  BREAK_LIMIT_MS,
  PRODUCTIVE_TARGET_MS,
  STATUS_DOT,
  STATUS_LABEL,
  formatClock,
  tickSummary,
  todayInReportZone,
} from "@/lib/attendance";
import { cn } from "@/lib/utils";

const MANUAL_OPTIONS: ManualWorkStatus[] = ["ACTIVE", "TEA_BREAK", "LUNCH_BREAK", "BIO_BREAK", "TEAM_HUDDLE"];

/** The salesperson's open shift with every figure ticking in the browser from the last server snapshot. */
function useLiveShift() {
  const role = useAuthStore((s) => s.user?.role);
  const { data, dataUpdatedAt, isSuccess } = useQuery({ ...myShiftQueryOptions(), enabled: role === "SALESPERSON" });
  const now = useNow(1000);

  const session = data?.session && !data.session.endedAt ? data.session : null;
  const live = useMemo(
    () => (session ? tickSummary(session.summary, session.status, now - dataUpdatedAt) : null),
    [session, now, dataUpdatedAt],
  );
  return { isSalesperson: role === "SALESPERSON", session, live, loaded: isSuccess };
}

function StatRow({ label, value, limit, warn }: { label: string; value: string; limit?: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-2 py-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", warn && "text-destructive")}>
        {value}
        {limit ? <span className="font-normal text-muted-foreground"> / {limit}</span> : null}
      </span>
    </div>
  );
}

/**
 * The 9 hour shift countdown. `center` is the pill shown in the middle of the header on large
 * screens; `inline` is the compact version that sits beside the status menu on smaller ones.
 */
export function ShiftTimer({ variant }: { variant: "center" | "inline" }) {
  const { isSalesperson, session, live } = useLiveShift();
  if (!isSalesperson || !session || !live) return null;

  const over = live.shiftOverrunMs > 0;
  const clock = over ? `+${formatClock(live.shiftOverrunMs)}` : formatClock(live.shiftRemainingMs);
  const label = over ? "over shift" : "shift left";
  const title = over ? "Time past your 9 hour shift" : "Time left in your 9 hour shift";

  if (variant === "inline") {
    return (
      <span className={cn("hidden text-sm font-semibold tabular-nums sm:inline", over && "text-destructive")} title={title}>
        {clock}
      </span>
    );
  }

  return (
    <div
      title={title}
      className={cn(
        "flex items-center gap-2.5 rounded-full border-[1.5px] px-4 py-1.5 shadow-sm transition-all",
        over ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-primary/20 bg-primary/5 text-primary",
      )}
    >
      <Timer className="size-4.5 shrink-0" />
      <span className="font-heading text-lg leading-none font-black tabular-nums tracking-tight">{clock}</span>
      <span className="text-[10px] font-bold whitespace-nowrap opacity-80 uppercase tracking-wider">{label}</span>
    </div>
  );
}

/**
 * Warns once per day when the 1h break allowance or the 9h shift is crossed (flag only - nothing is
 * blocked). Renders nothing. Mount it exactly once: the header renders the status menu in two
 * responsive layouts, so putting this inside the menu fired every toast twice.
 */
export function ShiftLimitToasts() {
  const userId = useAuthStore((s) => s.user?.id);
  const { session, live } = useLiveShift();

  useEffect(() => {
    if (!userId || !session || !live) return;
    // Remembered per person per day in this browser, so a refresh (or logging out and back in) doesn't
    // repeat a warning they've already seen. Falls back to showing it if storage is unavailable.
    const alreadyShown = (kind: string): boolean => {
      const key = `attendance-warned:${userId}:${todayInReportZone()}:${kind}`;
      try {
        if (localStorage.getItem(key)) return true;
        localStorage.setItem(key, "1");
      } catch {
        // Storage blocked - show the toast; the fixed toast id still prevents stacking.
      }
      return false;
    };

    if (live.breakOverageMs > 0 && !alreadyShown("break-over")) {
      toast.warning("Break allowance used up - total breaks are over 1 hour.", { id: "attendance-break-over" });
    }
    if (live.shiftOverrunMs > 0 && !alreadyShown("shift-over")) {
      toast.info("Your 9 hour shift is complete.", { id: "attendance-shift-over" });
    }
  }, [userId, session, live]);

  return null;
}

/**
 * Salesperson-only status control: shows the current status and lets them switch between Active,
 * the three breaks and Team Huddle. On a call / Idle are set automatically, so they are not options.
 */
export function WorkStatusMenu() {
  const { isSalesperson, session, live, loaded } = useLiveShift();
  const setStatus = useSetWorkStatusMutation();
  const clockIn = useStartShiftMutation();
  const clockOut = useEndShiftMutation();

  if (!isSalesperson || !loaded) return null;
  if (!session || !live) {
    return (
      <Button
        size="sm"
        className="h-[34px] gap-2 rounded-full px-4 shadow-sm"
        disabled={clockIn.isPending}
        onClick={() =>
          clockIn.mutate(undefined, {
            onError: (error) => toast.error(getErrorMessage(error, "Could not clock in.")),
          })
        }
      >
        <LogIn className="size-4" />
        <span className="font-semibold">{clockIn.isPending ? "Clocking in…" : "Clock in"}</span>
      </Button>
    );
  }

  const automatic = session.status === "ON_CALL" || session.status === "IDLE";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-[34px] gap-2 rounded-full border-[1.5px] px-4 shadow-sm" aria-label="Change my status" />}>
        <span className={cn("size-2.5 rounded-full shadow-sm", STATUS_DOT[session.status])} />
        <span className="font-semibold">{STATUS_LABEL[session.status]}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs">
            {automatic
              ? `${STATUS_LABEL[session.status]} (automatic) - pick a status to switch`
              : "Set my status"}
          </DropdownMenuLabel>
          {MANUAL_OPTIONS.map((option) => {
            const selected = session.status === option;
            return (
              <DropdownMenuItem
                key={option}
                disabled={setStatus.isPending}
                onClick={() =>
                  !selected &&
                  setStatus.mutate(option, {
                    onError: (error) => toast.error(getErrorMessage(error, "Could not change status.")),
                  })
                }
              >
                <span className={cn("size-2 rounded-full", STATUS_DOT[option])} />
                <span className={cn("flex-1", selected && "font-semibold")}>{STATUS_LABEL[option]}</span>
                {selected ? <Check className="size-4 text-primary" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="py-1">
          <StatRow
            label="Break used"
            value={formatClock(live.breakTotalMs)}
            limit={formatClock(BREAK_LIMIT_MS)}
            warn={live.breakOverageMs > 0}
          />
          <StatRow
            label="Productive"
            value={formatClock(live.productiveMs)}
            limit={formatClock(PRODUCTIVE_TARGET_MS)}
          />
          <StatRow label="On calls" value={formatClock(live.callingMs)} />
          <StatRow label="Team huddle" value={formatClock(live.huddleMs)} />
          <StatRow label="Idle" value={formatClock(live.idleMs)} />
        </div>
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">
          Tea, lunch and bio breaks share one 1 hour allowance. Team huddle is not a break.
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={clockOut.isPending}
          onClick={() =>
            clockOut.mutate(undefined, {
              onSuccess: () => toast.success("Clocked out. Your time today is saved."),
              onError: (error) => toast.error(getErrorMessage(error, "Could not clock out.")),
            })
          }
        >
          <LogOut className="size-4" />
          <span className="font-semibold">{clockOut.isPending ? "Clocking out…" : "Clock out"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
