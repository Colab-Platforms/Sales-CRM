"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckList } from "@/components/orders/column-filter";
import { getErrorMessage } from "@/lib/api-client/client";
import { managerAutoAssignConfigQueryOptions, salespersonAutoAssignConfigQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { managersQueryOptions } from "@/lib/api-client/queries/admin.queries";
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

// Picks which managers participate in the round robin before turning it on (or to change the set
// while it's already on) - ticking nobody and hitting Save would be pointless, so Save is disabled
// until at least one manager is checked.
function ManagerPickerDialog({ open, onOpenChange, initialSelected, onSave, saving }: { open: boolean; onOpenChange: (open: boolean) => void; initialSelected: string[]; onSave: (managerIds: string[]) => void; saving: boolean }) {
  const managersQuery = useQuery(managersQueryOptions());
  const [selected, setSelected] = useState<string[]>(initialSelected);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setSelected(initialSelected);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Select managers for auto-assignment</DialogTitle>
          <DialogDescription>Only the managers you select here will receive new abandoned leads automatically.</DialogDescription>
        </DialogHeader>
        {managersQuery.isPending ? <Skeleton className="h-24 w-full" /> : null}
        {managersQuery.error ? <p role="alert" className="text-sm text-destructive">Failed to load managers.</p> : null}
        {managersQuery.data ? (
          <CheckList
            options={managersQuery.data.map((m) => ({ value: m.id, label: m.name }))}
            selected={selected}
            onChange={setSelected}
            emptyText="No managers found"
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(selected)} disabled={saving || selected.length === 0}>
            Save &amp; turn on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ManagerAutoAssignToggle() {
  const query = useQuery(managerAutoAssignConfigQueryOptions());
  const mutation = useSetManagerAutoAssignMutation();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.error) return null;

  const { enabled, managerIds } = query.data;
  const onError = (err: unknown) => toast.error(getErrorMessage(err, "Failed to update auto-assignment."));

  return (
    <>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Auto-assign to managers</p>
              <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "On" : "Off"}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {enabled
                ? `Every new abandoned lead is round-robin assigned to one of ${managerIds.length} selected manager${managerIds.length === 1 ? "" : "s"}. When off, assign them manually below.`
                : "When on, every new abandoned lead is round-robin assigned to a manager you select automatically. When off, assign them manually below."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {enabled ? (
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)} disabled={mutation.isPending}>
                Manage managers
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => {
                if (enabled) {
                  mutation.mutate({ enabled: false }, { onError });
                } else {
                  setPickerOpen(true);
                }
              }}
            >
              {enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ManagerPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialSelected={managerIds}
        saving={mutation.isPending}
        onSave={(ids) =>
          mutation.mutate({ enabled: true, managerIds: ids }, {
            onError,
            onSuccess: () => setPickerOpen(false),
          })
        }
      />
    </>
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
