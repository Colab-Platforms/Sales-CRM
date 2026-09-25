"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Bell, BellRing, PhoneCall } from "lucide-react";
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
import { customerDetailHref } from "@/components/orders/orders-table";
import { myFollowUpsQueryOptions } from "@/lib/api-client/queries/tasks.queries";
import { cn } from "@/lib/utils";
import type { FollowUpTask } from "@/lib/api-client/types/tasks.types";
import { desktopAlertPermission, requestDesktopAlerts, type DesktopAlertPermission } from "./follow-up-alerts";
import { FOLLOW_UP_TYPE_LABEL, formatRelative, formatWhen, leadDisplayName } from "./follow-up-utils";

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function ReminderRow({ task, now, overdue, onOpen }: { task: FollowUpTask; now: number; overdue: boolean; onOpen: () => void }) {
  return (
    <DropdownMenuItem onClick={onOpen} className="items-start gap-2.5 py-2">
      <PhoneCall className={cn("mt-0.5 size-4 shrink-0", overdue ? "text-destructive" : "text-primary")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{leadDisplayName(task.lead)}</span>
          <span className={cn("shrink-0 text-xs", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
            {formatRelative(task.scheduledAt, now)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {FOLLOW_UP_TYPE_LABEL[task.type]} · {formatWhen(task.scheduledAt)}
        </div>
        {task.description ? <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/80">{task.description}</div> : null}
      </div>
    </DropdownMenuItem>
  );
}

/** Header bell: count of reminders due within the hour (or overdue), and the full upcoming list. */
export function FollowUpBell() {
  const router = useRouter();
  const now = useMinuteClock();
  const { data: followUps = [] } = useQuery(myFollowUpsQueryOptions());
  const [permission, setPermission] = useState<DesktopAlertPermission>(() => desktopAlertPermission());

  const overdue = followUps.filter((t) => new Date(t.scheduledAt).getTime() <= now);
  const upcoming = followUps.filter((t) => new Date(t.scheduledAt).getTime() > now);
  const urgentCount = followUps.filter((t) => new Date(t.scheduledAt).getTime() <= now + 60 * 60_000).length;

  const open = (task: FollowUpTask) => router.push(customerDetailHref(task.lead.id));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" className="relative" aria-label={`Follow-up reminders (${urgentCount} due soon)`} />
        }
      >
        {overdue.length > 0 ? <BellRing className="size-4.5 text-destructive" /> : <Bell className="size-4.5" />}
        {urgentCount > 0 ? (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] leading-4.5 font-bold text-white",
              overdue.length > 0 ? "bg-destructive" : "bg-primary",
            )}
          >
            {urgentCount > 9 ? "9+" : urgentCount}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Follow-ups</span>
            <span className="text-xs font-normal text-muted-foreground">next 36 hours</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />

        {followUps.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">No call backs or follow-ups scheduled.</div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {overdue.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-destructive">Overdue · {overdue.length}</DropdownMenuLabel>
                {overdue.map((task) => (
                  <ReminderRow key={task.id} task={task} now={now} overdue onOpen={() => open(task)} />
                ))}
              </DropdownMenuGroup>
            ) : null}
            {upcoming.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">Upcoming · {upcoming.length}</DropdownMenuLabel>
                {upcoming.map((task) => (
                  <ReminderRow key={task.id} task={task} now={now} overdue={false} onOpen={() => open(task)} />
                ))}
              </DropdownMenuGroup>
            ) : null}
          </div>
        )}

        {permission === "default" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void requestDesktopAlerts().then(setPermission)}>
              <BellRing />
              Turn on desktop alerts
            </DropdownMenuItem>
          </>
        ) : permission === "denied" ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Desktop alerts are blocked for this site — allow notifications in your browser settings to get them.
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
