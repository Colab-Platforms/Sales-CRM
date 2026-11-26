"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { FollowUpBell } from "@/components/follow-ups/follow-up-bell";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  ShiftTimer,
  WorkStatusMenu,
} from "@/components/attendance/work-status-widget";
import { DemoSwitcher } from "@/components/demo/demo-bar";
import type { Role } from "@/lib/api-client/types/auth.types";

export function SiteHeader({
  showFollowUps = true,
  demoRole,
}: {
  showFollowUps?: boolean;
  /** Set only in a DEMO session: shows the demo role switcher and hides the real attendance widgets. */
  demoRole?: Role;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 bg-background/85 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
      <SidebarTrigger className="-ml-1" />
      {/* Dead centre of the header on large screens; smaller screens get the compact timer on the right. */}
      {demoRole ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 hidden -translate-y-1/2 justify-center lg:flex">
          <div className="pointer-events-auto flex items-center gap-3">
            <WorkStatusMenu />
            <ShiftTimer variant="center" />
          </div>
        </div>
      )}
      <div className="ml-auto flex items-center gap-3">
        {demoRole ? (
          <DemoSwitcher role={demoRole} />
        ) : (
          <div className="flex items-center gap-3 lg:hidden">
            <WorkStatusMenu />
            <ShiftTimer variant="inline" />
          </div>
        )}
        {/* <FollowUpBell /> */}
        {/* Every role gets the theme switch, right beside the notification bell. */}
        <ThemeToggle />
        {showFollowUps ? <FollowUpBell /> : null}
      </div>
    </header>
  );
}
