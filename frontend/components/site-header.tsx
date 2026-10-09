"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { FollowUpBell } from "@/components/follow-ups/follow-up-bell";
import {
  ShiftTimer,
  WorkStatusMenu,
} from "@/components/attendance/work-status-widget";

export function SiteHeader({
  showFollowUps = true,
}: {
  showFollowUps?: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b-[1.5px] border-border bg-background/85 px-4 backdrop-blur-sm sm:px-6">
      <SidebarTrigger className="-ml-1" />
      {/* Dead centre of the header on large screens; smaller screens get the compact timer on the right. */}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 hidden -translate-y-1/2 justify-center lg:flex">
        <div className="pointer-events-auto flex items-center gap-3">
          <WorkStatusMenu />
          <ShiftTimer variant="center" />
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-3 lg:hidden">
          <WorkStatusMenu />
          <ShiftTimer variant="inline" />
        </div>
        {/* <FollowUpBell /> */}
        {showFollowUps ? <FollowUpBell /> : null}
      </div>
    </header>
  );
}
