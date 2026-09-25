"use client";

import { usePathname } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  leads: "Leads",
  calling: "Call History",
  team: "Team",
  salespersons: "Salespersons",
  users: "Managers",
};

function labelFor(segment: string) {
  return SEGMENT_LABELS[segment] ?? segment.replace(/-/g, " ");
}

/**
 * The title used to be hardcoded, so every page read "Dashboard". It now
 * tracks the route and shows the trail for nested pages.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const trail = segments.map(labelFor);
  const current = trail.at(-1) ?? "Dashboard";
  const parents = trail.slice(0, -1);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b-[1.5px] border-border bg-background/85 px-4 backdrop-blur-sm sm:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="h-5" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        {parents.map((parent) => (
          <span key={parent} className="hidden items-center gap-1.5 sm:flex">
            <span className="text-muted-foreground capitalize">{parent}</span>
            <span className="text-muted-foreground/50">/</span>
          </span>
        ))}
        <span className="truncate font-bold capitalize">{current}</span>
      </nav>
    </header>
  );
}
