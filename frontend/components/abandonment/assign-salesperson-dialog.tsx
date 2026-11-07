"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { assignableTelecallersQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { useAuthStore } from "@/stores/auth-store";
import { useBulkAssignSalespersonMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import type { BulkAssignSalespersonResult } from "@/lib/api-client/types/abandonment.types";
import { countByPerson, roundRobinPlan } from "@/lib/assignment-plan";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/** Looks up the name and number of a selected lead (known from the pages shown and from "Select all"). */
export type LeadLabelLookup = (abandonmentId: string) => { name: string; leadNumber: string } | undefined;

type Method = "MANUAL" | "ROUND_ROBIN";

/**
 * Assign the selected abandoned leads to salespeople. Two modes, both with several salespeople:
 *  - Manual: tick the salespeople, then choose which of them gets each lead (or fill the choices in one go).
 *  - Round Robin: tick the salespeople; the leads are dealt one by one across them, as evenly as possible (100 leads over 3 people = 34 / 33 / 33), with a preview before confirming.
 * The server saves the whole request or none of it; the result screen shows what was actually saved per salesperson.
 */
export function AssignAbandonmentSalespersonDialog({
  open,
  onOpenChange,
  abandonmentIds,
  labelOf,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  abandonmentIds: string[];
  labelOf?: LeadLabelLookup;
  onDone: () => void;
}) {
  // Admin / HR pick from every active telecaller, a manager from their own team.
  const role = useAuthStore((s) => s.user?.role);
  const direct = role === "ADMIN" || role === "HR";
  const managerTeam = useQuery({ ...mySalespersonsQueryOptions(), enabled: open && !direct });
  const allTelecallers = useQuery({ ...assignableTelecallersQueryOptions(), enabled: open && direct });
  const { data: salespersons, isPending, error } = direct ? allTelecallers : managerTeam;
  const bulkAssign = useBulkAssignSalespersonMutation();
  const [method, setMethod] = useState<Method>("ROUND_ROBIN");
  const [chosen, setChosen] = useState<string[]>([]); // in the order they were ticked: the Round Robin order
  const [manual, setManual] = useState<Record<string, string>>({}); // abandonmentId -> salespersonId ("" = not assigned)
  const [result, setResult] = useState<BulkAssignSalespersonResult | null>(null);

  const team = useMemo(() => salespersons ?? [], [salespersons]);
  const nameOf = (id: string) => team.find((t) => t.id === id)?.name ?? "Salesperson";

  // Reset the form each time the dialog opens (adjusting state during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMethod("ROUND_ROBIN");
      setChosen([]);
      setManual({});
      setResult(null);
      bulkAssign.reset();
    }
  }

  function toggle(id: string, checked: boolean) {
    setChosen((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
    // a salesperson who is un-ticked can no longer be the manual choice of a lead
    if (!checked) setManual((prev) => Object.fromEntries(Object.entries(prev).map(([lead, sp]) => [lead, sp === id ? "" : sp])));
  }

  const roundRobin = useMemo(() => roundRobinPlan(abandonmentIds, chosen), [abandonmentIds, chosen]);
  const manualPlan = abandonmentIds.flatMap((id) => (manual[id] && chosen.includes(manual[id]!) ? [{ abandonmentId: id, salespersonId: manual[id]! }] : []));
  const plan = method === "ROUND_ROBIN" ? roundRobin : manualPlan;
  const summary = countByPerson(plan, chosen);
  const unassignedManual = method === "MANUAL" ? abandonmentIds.length - manualPlan.length : 0;

  const problem =
    abandonmentIds.length === 0 ? "No leads are selected." : chosen.length === 0 ? "Select at least one salesperson." : method === "MANUAL" && manualPlan.length === 0 ? "Choose a salesperson for at least one lead." : null;

  function handleSubmit() {
    if (problem) return;
    bulkAssign.mutate(
      method === "ROUND_ROBIN" ? { abandonmentIds, method, salespersonIds: chosen } : { abandonmentIds, method, assignments: manualPlan },
      {
        onSuccess: (res) => {
          setResult(res);
          toast.success(`${res.assignedCount} abandoned lead(s) assigned${res.unchangedCount ? `; ${res.unchangedCount} already belonged to that salesperson` : ""}.`);
        },
      },
    );
  }

  function close() {
    if (result) onDone();
    else onOpenChange(false);
  }

  const label = (id: string) => labelOf?.(id);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      {open ? (
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{result ? "Assignment saved" : "Assign Salesperson"}</DialogTitle>
            <DialogDescription>{abandonmentIds.length} abandoned lead(s) selected.</DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-3" data-testid="assign-result">
              <p className="text-sm">
                <span className="font-semibold">{result.assignedCount}</span> lead{result.assignedCount === 1 ? "" : "s"} assigned
                {result.unchangedCount ? `, ${result.unchangedCount} already belonged to the chosen salesperson` : ""}.
              </p>
              <div className="sketch-outline divide-y text-sm">
                {chosen.map((id) => {
                  const row = result.perSalesperson?.find((r) => r.salespersonId === id);
                  return (
                    <div key={id} className="flex items-center justify-between px-3 py-2" data-testid="assign-result-row">
                      <span>{row?.name ?? nameOf(id)}</span>
                      <span className="tabular-nums">
                        <span className="font-semibold">{row?.assignedCount ?? 0}</span> assigned{row?.unchangedCount ? ` · ${row.unchangedCount} unchanged` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
              {unassignedManual > 0 ? <p className="text-xs text-muted-foreground">{unassignedManual} selected lead(s) had no salesperson chosen and were left as they were.</p> : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Assignment mode">
                {(["MANUAL", "ROUND_ROBIN"] as const).map((m) => (
                  <label key={m} className="sketch-outline flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm font-medium has-checked:border-primary/60 has-checked:bg-primary/8">
                    <input type="radio" name="assign-mode" checked={method === m} onChange={() => setMethod(m)} />
                    {m === "MANUAL" ? "Manual" : "Round Robin"}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground" data-testid="mode-help">
                {method === "MANUAL"
                  ? "Tick the salespeople, then choose which of them gets each lead. Leads you leave unchosen are not assigned."
                  : "Tick the salespeople. The selected leads are dealt one by one across them, in the order ticked, as evenly as possible."}
              </p>

              {error ? <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load salespeople.")}</p> : null}
              {!isPending && !error && team.length === 0 ? <p className="text-sm text-muted-foreground">{direct ? "No active telecallers found." : "No salespeople report to you yet."}</p> : null}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Salespeople ({chosen.length} selected)</Label>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setChosen(team.map((t) => t.id))} disabled={team.length === 0}>Select all</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setChosen([]); setManual({}); }} disabled={chosen.length === 0}>Clear</Button>
                  </div>
                </div>
                <div className="sketch-outline max-h-40 space-y-0.5 overflow-y-auto p-1.5">
                  {team.map((sp) => (
                    <label key={sp.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
                      <input type="checkbox" checked={chosen.includes(sp.id)} onChange={(e) => toggle(sp.id, e.target.checked)} />
                      <span className="flex-1">{sp.name}{sp.groupName ? ` — ${sp.groupName}` : ""}</span>
                      {method === "ROUND_ROBIN" && chosen.includes(sp.id) ? <span className="text-xs tabular-nums text-muted-foreground">#{chosen.indexOf(sp.id) + 1}</span> : null}
                    </label>
                  ))}
                </div>
              </div>

              {method === "MANUAL" && chosen.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>Who gets each lead</Label>
                    <div className="flex flex-wrap items-center gap-1">
                      <NativeSelect aria-label="Give every lead to" value="" onChange={(e) => e.target.value && setManual(Object.fromEntries(abandonmentIds.map((id) => [id, e.target.value])))} className="h-8 w-44">
                        <option value="">All leads to…</option>
                        {chosen.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
                      </NativeSelect>
                      <Button type="button" size="sm" variant="outline" onClick={() => setManual(Object.fromEntries(roundRobinPlan(abandonmentIds, chosen).map((p) => [p.abandonmentId, p.salespersonId])))}>Split evenly</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setManual({})}>Clear</Button>
                    </div>
                  </div>
                  <div className="sketch-outline max-h-56 divide-y overflow-y-auto" data-testid="manual-leads">
                    {abandonmentIds.map((id) => (
                      <div key={id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {label(id)?.name ?? "Lead"} <span className="text-xs text-muted-foreground">{label(id)?.leadNumber ?? id.slice(0, 8)}</span>
                        </span>
                        <NativeSelect aria-label={`Salesperson for ${label(id)?.name ?? id}`} value={manual[id] ?? ""} onChange={(e) => setManual((prev) => ({ ...prev, [id]: e.target.value }))} className="h-8 w-44">
                          <option value="">Not assigned</option>
                          {chosen.map((sp) => <option key={sp} value={sp}>{nameOf(sp)}</option>)}
                        </NativeSelect>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {chosen.length > 0 ? (
                <div className="space-y-1.5" data-testid="assign-preview">
                  <Label>{method === "ROUND_ROBIN" ? "Preview: how the leads will be shared" : "Summary"}</Label>
                  <div className="sketch-outline divide-y text-sm">
                    {summary.map((row) => (
                      <div key={row.salespersonId} className="flex items-center justify-between px-3 py-1.5" data-testid="assign-preview-row">
                        <span>{nameOf(row.salespersonId)}</span>
                        <span className="tabular-nums"><span className="font-semibold">{row.count}</span> lead{row.count === 1 ? "" : "s"}</span>
                      </div>
                    ))}
                  </div>
                  {unassignedManual > 0 ? <p className="text-xs text-amber-600">{unassignedManual} lead(s) have no salesperson chosen and will not be assigned.</p> : null}
                </div>
              ) : null}

              {problem && (chosen.length === 0 || method === "MANUAL") ? <p className="text-xs text-muted-foreground" data-testid="assign-problem">{problem}</p> : null}
              {bulkAssign.error ? (
                <p className="text-sm text-destructive" role="alert">
                  {getErrorMessage(bulkAssign.error, "Failed to assign abandoned leads.")} No leads were assigned - the whole request is saved or none of it.
                </p>
              ) : null}
            </div>
          )}

          <DialogFooter>
            {result ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={bulkAssign.isPending}>Cancel</Button>
                <Button onClick={handleSubmit} disabled={Boolean(problem) || bulkAssign.isPending} data-testid="assign-confirm">
                  {bulkAssign.isPending ? "Assigning..." : `Assign ${plan.length} lead${plan.length === 1 ? "" : "s"}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
