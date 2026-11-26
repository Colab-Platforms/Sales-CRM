"use client";

import { FlaskConical, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useDemo } from "@/hooks/useDemo";
import { DEMO_ROLE_OPTIONS, type DemoRole } from "@/lib/demo";
import type { Role } from "@/lib/api-client/types/auth.types";

/** The persistent banner of a demo session: always visible, on every page. */
export function DemoBanner() {
  return (
    <div role="status" data-testid="demo-banner" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
      <span className="inline-flex items-center gap-1.5 tracking-wide uppercase">
        <FlaskConical className="size-3.5" aria-hidden /> Demo mode
      </span>
      <span className="font-medium">Sample data only. Nothing is sent, saved to a real account or charged.</span>
    </div>
  );
}

/** Top-right of the header, demo sessions only: switch the demo role without signing out, or leave the demo. */
export function DemoSwitcher({ role }: { role: Role }) {
  const { switchRole, exit, busy, error } = useDemo();
  return (
    <div className="flex items-center gap-2" data-testid="demo-switcher">
      <label htmlFor="demo-role" className="sr-only">
        Demo role
      </label>
      <NativeSelect
        id="demo-role"
        size="sm"
        aria-label="Switch demo role"
        wrapperClassName="w-36"
        value={role}
        disabled={busy}
        onChange={(e) => void switchRole(e.target.value as DemoRole)}
      >
        {DEMO_ROLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      <Button type="button" variant="outline" size="sm" onClick={() => exit("/demo")} data-testid="demo-exit">
        <LogOut data-icon="inline-start" />
        <span className="hidden sm:inline">Exit demo</span>
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
