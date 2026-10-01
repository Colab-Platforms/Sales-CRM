"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/api-client/client";
import { managerAutoAssignConfigQueryOptions, salespersonAutoAssignConfigQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { useSetManagerAutoAssignMutation, useSetSalespersonAutoAssignMutation } from "@/lib/api-client/mutations/abandonment.mutations";

// Sits above the manual assign-manager/assign-salesperson flow on the Abandoned Leads page - manual
// assignment stays available either way, this only decides whether a new abandoned lead also gets
// round-robin auto-assigned the moment it arrives. See backend's autoAssignAbandonedLead.
function ToggleCard({ title, description, enabled, pending, onToggle }: { title: string; description: string; enabled: boolean; pending: boolean; onToggle: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{title}</p>
            <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "On" : "Off"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onToggle} disabled={pending}>
          {enabled ? "Turn off" : "Turn on"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ManagerAutoAssignToggle() {
  const query = useQuery(managerAutoAssignConfigQueryOptions());
  const mutation = useSetManagerAutoAssignMutation();

  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.error) return null;

  return (
    <ToggleCard
      title="Auto-assign to managers"
      description="When on, every new abandoned lead is round-robin assigned to an active manager automatically. When off, assign them manually below."
      enabled={query.data.enabled}
      pending={mutation.isPending}
      onToggle={() =>
        mutation.mutate(!query.data.enabled, {
          onError: (err) => toast.error(getErrorMessage(err, "Failed to update auto-assignment.")),
        })
      }
    />
  );
}

export function SalespersonAutoAssignToggle() {
  const query = useQuery(salespersonAutoAssignConfigQueryOptions());
  const mutation = useSetSalespersonAutoAssignMutation();

  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.error) return null;

  return (
    <ToggleCard
      title="Auto-assign to your salespeople"
      description="When on, abandoned leads assigned to you are round-robin handed to your active salespeople automatically. When off, assign them manually below."
      enabled={query.data.enabled}
      pending={mutation.isPending}
      onToggle={() =>
        mutation.mutate(!query.data.enabled, {
          onError: (err) => toast.error(getErrorMessage(err, "Failed to update auto-assignment.")),
        })
      }
    />
  );
}
