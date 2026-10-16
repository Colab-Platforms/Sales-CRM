"use client";

import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { Card, CardContent } from "@/components/ui/card";

// The backend enforces the same rule (MANAGER or ADMIN); this only spares other roles a failed request.
const REPORT_ROLES = new Set(["MANAGER", "ADMIN"]);

/** Renders its children for managers and admins; everyone else gets a plain "no access" card. */
export function ReportAccess({ children }: { children: (role: "MANAGER" | "ADMIN") => ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  if (!role) return null;
  if (!REPORT_ROLES.has(role)) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-14 text-center">
          <ShieldAlert className="size-9 text-muted-foreground/40" />
          <p className="font-heading text-lg font-medium">This page is for managers and admins</p>
          <p className="text-sm text-muted-foreground">Ask your manager if you need these figures.</p>
        </CardContent>
      </Card>
    );
  }
  return <>{children(role as "MANAGER" | "ADMIN")}</>;
}
