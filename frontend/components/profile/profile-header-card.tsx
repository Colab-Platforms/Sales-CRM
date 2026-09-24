import { Mail, Phone, CalendarClock, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/order-status";
import type { UserProfile } from "@/lib/api-client/types/auth.types";

const ROLE_LABELS: Record<UserProfile["role"], string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  SALESPERSON: "Salesperson",
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProfileHeaderCard({ profile }: { profile: UserProfile }) {
  const isActive = profile.status === "ACTIVE";

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-4">
          <span
            aria-hidden="true"
            className="flex size-16 shrink-0 items-center justify-center rounded-[18px_14px_19px_14px] border-2 border-ink-line/40 bg-primary/10 text-xl font-extrabold text-primary"
          >
            {initials(profile.name)}
          </span>
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-xl font-extrabold">{profile.name}</h2>
              <Badge variant="secondary">{ROLE_LABELS[profile.role]}</Badge>
              <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Active" : "Inactive"}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{profile.email}</p>
          </div>
        </div>

        <div className="grid gap-4 border-t border-dashed border-ink-line/30 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex items-start gap-2.5">
            <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs text-muted-foreground">Email</p>
              <p className="truncate text-sm font-medium">{profile.email}</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs text-muted-foreground">Phone</p>
              <p className="truncate text-sm font-medium">{profile.phone ?? "—"}</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs text-muted-foreground">Member since</p>
              <p className="truncate text-sm font-medium">{formatDate(profile.createdAt)}</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs text-muted-foreground">Last login</p>
              <p className="truncate text-sm font-medium">{formatDateTime(profile.lastLoginAt)}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
