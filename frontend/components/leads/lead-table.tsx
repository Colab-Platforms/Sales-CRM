"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, Loader2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Inbox, Pencil, Trash2 } from "lucide-react";
import { History } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { customerDetailHref } from "@/components/orders/orders-table";
import { useUpdateLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import { useInitiateCallMutation, useSubmitCallOutcomeMutation } from "@/lib/api-client/mutations/calling.mutations";
import { virtualNumbersQueryOptions, callOutcomesQueryOptions, leadCallsQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { EditLeadDialog } from "./edit-lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";
import type {
  Lead,
  LeadListPagination,
} from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";
import type { Call, CallStatus } from "@/lib/api-client/types/calling.types";

const CALL_STATUS_VARIANT: Record<
  CallStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  INITIATED: "outline",
  RINGING_AGENT: "outline",
  AGENT_ANSWERED: "outline",
  RINGING_CUSTOMER: "outline",
  CONNECTED: "default",
  COMPLETED: "default",
  NO_ANSWER: "secondary",
  BUSY: "secondary",
  NOT_REACHABLE: "secondary",
  FAILED: "destructive",
};

// A call the salesperson can (and should) log an outcome for - it's over, one way or another.
// Deliberately not limited to calls that connected: BUSY/NO_ANSWER/NOT_REACHABLE/FAILED are
// themselves outcomes a salesperson picks (they just never require a note - see requiresNote below).
const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "NOT_REACHABLE",
  "FAILED",
]);

function CallOutcomeForm({ leadId, call, onSaved }: { leadId: string; call: Call; onSaved?: () => void }) {
  const { data: outcomes = [] } = useQuery(callOutcomesQueryOptions());
  const submitOutcome = useSubmitCallOutcomeMutation(leadId);
  const [outcomeId, setOutcomeId] = useState(call.outcome?.id ?? "");
  const [notes, setNotes] = useState(call.notes ?? "");

  const selectedOutcome = outcomes.find((o) => o.id === outcomeId);
  const noteMissing = Boolean(selectedOutcome?.requiresNote) && !notes.trim();

  function handleSave() {
    if (!outcomeId) return;
    submitOutcome.mutate(
      { callId: call.id, payload: { outcomeId, notes: notes.trim() || undefined } },
      {
        onSuccess: () => {
          toast.success("Call outcome saved.");
          onSaved?.();
        },
        onError: (error) => toast.error(getErrorMessage(error, "Failed to save call outcome.")),
      },
    );
  }

  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      <NativeSelect
        size="sm"
        aria-label="Call outcome"
        value={outcomeId}
        disabled={submitOutcome.isPending}
        onChange={(e) => setOutcomeId(e.target.value)}
      >
        <option value="">{call.outcome ? call.outcome.name : "Log outcome…"}</option>
        {outcomes.map((outcome) => (
          <option key={outcome.id} value={outcome.id}>
            {outcome.name}
          </option>
        ))}
      </NativeSelect>
      {/* Required once the outcome says the customer actually spoke (picked up) - not for a call that never connected. */}
      {selectedOutcome?.requiresNote ? (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="What did the customer say? (required)"
          className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={!outcomeId || noteMissing || submitOutcome.isPending}
        onClick={handleSave}
      >
        Save outcome
      </Button>
    </div>
  );
}

function CallHistoryDialogContent({ lead }: { lead: Lead }) {
  return (
    <DialogContent className="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>
          {lead.firstName} {lead.lastName ?? ""} — Call History
        </DialogTitle>
        <DialogDescription>
          Click-to-call attempts logged for this lead.
        </DialogDescription>
      </DialogHeader>
      {lead.calls.length === 0 ? (
        <p className="text-sm text-muted-foreground">No calls yet.</p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {lead.calls.map((call) => (
            <div
              key={call.id}
              className="sketch-outline space-y-2 p-2.5 text-sm"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">
                    {call.startedAt
                      ? new Date(call.startedAt).toLocaleString()
                      : "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {call.agent?.name ?? "Unknown agent"}
                    {call.durationSeconds ? ` · ${call.durationSeconds}s` : ""}
                  </p>
                </div>
                <Badge variant={CALL_STATUS_VARIANT[call.status]}>
                  {call.status.replaceAll("_", " ")}
                </Badge>
              </div>
              {call.recording?.recordingUrl ? (
                <audio
                  controls
                  className="w-full"
                  src={call.recording.recordingUrl}
                />
              ) : null}
              {call.notes ? (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{call.outcome?.name}:</span> {call.notes}
                </p>
              ) : null}
              {TERMINAL_CALL_STATUSES.has(call.status) ? (
                <CallOutcomeForm leadId={lead.id} call={call} />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </DialogContent>
  );
}

function CallHistoryButton({ lead }: { lead: Lead }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Call history"
        onClick={() => setIsOpen(true)}
      >
        <History className="size-3.5" />
      </Button>
      {isOpen ? <CallHistoryDialogContent lead={lead} /> : null}
    </Dialog>
  );
}

// One line of human-readable text per non-terminal CallStatus, shown while the popup is watching
// the call. Terminal statuses never reach here - they flip the popup into the outcome form instead.
const IN_PROGRESS_LABEL: Record<CallStatus, string> = {
  INITIATED: "Starting the call…",
  RINGING_AGENT: "Ringing your phone…",
  AGENT_ANSWERED: "Connecting you to the customer…",
  RINGING_CUSTOMER: "Ringing the customer…",
  CONNECTED: "On call…",
  COMPLETED: "Call ended",
  NO_ANSWER: "Call ended",
  BUSY: "Call ended",
  NOT_REACHABLE: "Call ended",
  FAILED: "Call ended",
};

// Live view of one just-started call: polls this lead's calls every 3s (webhook-driven status, no
// push channel exists) until this call reaches a terminal status, then swaps straight into the same
// outcome form the call history uses - so logging the result never waits on the salesperson
// remembering to open history afterwards.
function ActiveCallDialog({ lead, callId, onClose }: { lead: Lead; callId: string; onClose: () => void }) {
  const { data: calls } = useQuery({
    ...leadCallsQueryOptions(lead.id),
    refetchInterval: (query) => {
      const call = query.state.data?.find((c) => c.id === callId);
      return call && TERMINAL_CALL_STATUSES.has(call.status) ? false : 3000;
    },
  });
  const call = calls?.find((c) => c.id === callId);
  const ended = Boolean(call && TERMINAL_CALL_STATUSES.has(call.status));

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {lead.firstName} {lead.lastName ?? ""}
          </DialogTitle>
          <DialogDescription>
            {ended ? "Call ended — log what happened." : "Call in progress."}
          </DialogDescription>
        </DialogHeader>

        {!ended ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {call ? IN_PROGRESS_LABEL[call.status] : "Starting the call…"}
          </div>
        ) : (
          call && (
            <div className="space-y-2">
              <Badge variant={CALL_STATUS_VARIANT[call.status]}>
                {call.status.replaceAll("_", " ")}
                {call.durationSeconds ? ` · ${call.durationSeconds}s` : ""}
              </Badge>
              <CallOutcomeForm leadId={lead.id} call={call} onSaved={onClose} />
            </div>
          )
        )}

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {ended ? "Log later" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClickToCallButton({ lead }: { lead: Lead }) {
  const initiateCall = useInitiateCallMutation(lead.id);
  const { data: virtualNumbers = [] } = useQuery(virtualNumbersQueryOptions());
  const [virtualNumberId, setVirtualNumberId] = useState("");
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const selected = virtualNumberId || virtualNumbers[0]?.id || "";

  if (!lead.mobile) return null;

  return (
    <div className="flex items-center gap-1">
      <NativeSelect
        size="sm"
        aria-label="Call from virtual number"
        className="text-xs"
        wrapperClassName="w-28"
        value={selected}
        disabled={initiateCall.isPending || virtualNumbers.length === 0}
        onChange={(e) => setVirtualNumberId(e.target.value)}
      >
        {virtualNumbers.length === 0 ? <option value="">No line</option> : null}
        {virtualNumbers.map((vn) => (
          <option key={vn.id} value={vn.id}>
            {vn.displayName ?? vn.number}
          </option>
        ))}
      </NativeSelect>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={`Call ${lead.firstName}`}
        disabled={initiateCall.isPending || !selected}
        onClick={() =>
          initiateCall.mutate(selected, {
            onSuccess: (result) => {
              toast.success("Calling your phone now — hold on.");
              setActiveCallId(result.callId);
            },
            onError: (error) =>
              toast.error(getErrorMessage(error, "Failed to start call.")),
          })
        }
      >
        <Phone className="size-3.5" />
      </Button>
      {activeCallId ? (
        <ActiveCallDialog lead={lead} callId={activeCallId} onClose={() => setActiveCallId(null)} />
      ) : null}
    </div>
  );
}

function LeadStatusSelect({ lead }: { lead: Lead }) {
  const updateLead = useUpdateLeadMutation();

  return (
    <NativeSelect
      size="sm"
      aria-label={`Status for ${lead.firstName}`}
      value={lead.workingStatus}
      disabled={updateLead.isPending}
      wrapperClassName="w-40"
      onChange={(e) =>
        updateLead.mutate(
          {
            id: lead.id,
            payload: { workingStatus: e.target.value as LeadWorkingStatus },
          },
          { onSuccess: () => toast.success("Status updated.") },
        )
      }
    >
      {/* ASSIGNED is set by assigning a lead; only shown while the lead already has it (never for a salesperson). */}
      {STATUS_ORDER.filter((status) => status !== "ASSIGNED" || lead.workingStatus === "ASSIGNED").map((status) => (
        <option key={status} value={status}>
          {STATUS_LABELS[status]}
        </option>
      ))}
    </NativeSelect>
  );
}

interface LeadTableProps {
  leads: Lead[];
  isLoading: boolean;
  role: Role;
  selectedIds: Set<string>;
  onToggleOne: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  pagination?: LeadListPagination;
  onPageChange: (page: number) => void;
}

export function LeadTable({
  leads,
  isLoading,
  role,
  selectedIds,
  onToggleOne,
  onToggleAll,
  pagination,
  onPageChange,
}: LeadTableProps) {
  const allSelected =
    leads.length > 0 && leads.every((lead) => selectedIds.has(lead.id));
  const columnCount = (role !== "SALESPERSON" ? 9 : 8) + 1;
  const [editingLeadId, setEditingLeadId] = useState<string | null>(null);
  const [deletingLead, setDeletingLead] = useState<{
    id: string;
    name: string;
  } | null>(null);

  if (isLoading) {
    return (
      <div className="sketch-panel space-y-3 bg-card p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="sketch-panel overflow-x-auto bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 pl-4">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  aria-label="Select all leads"
                />
              </TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              {role !== "SALESPERSON" ? <TableHead>Manager</TableHead> : null}
              <TableHead>Salesperson</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right pr-4">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Inbox className="size-8 text-muted-foreground/40" />
                    <p className="font-semibold">No leads found</p>
                    <p className="font-hand text-base text-muted-foreground">
                      Try clearing your filters, or add a lead.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  data-state={selectedIds.has(lead.id) ? "selected" : undefined}
                >
                  <TableCell className="pl-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(lead.id)}
                      onChange={(e) => onToggleOne(lead.id, e.target.checked)}
                      aria-label={`Select ${lead.firstName}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={customerDetailHref(lead.id)}
                      className="font-semibold hover:underline"
                    >
                      {lead.firstName} {lead.lastName ?? ""}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {lead.leadNumber}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span>{lead.mobile ?? "—"}</span>
                      <ClickToCallButton lead={lead} />
                      <CallHistoryButton lead={lead} />
                    </div>
                    {lead.email ? (
                      <div className="text-xs text-muted-foreground">
                        {lead.email}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div>{lead.source?.name ?? "—"}</div>
                    {lead.importBatch ? (
                      <div className="text-xs text-muted-foreground">
                        via {lead.importBatch.uploadedBy.name} (
                        {lead.importBatch.uploadedBy.role})
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {role === "SALESPERSON" ? (
                      <LeadStatusSelect lead={lead} />
                    ) : (
                      <StatusBadge status={lead.workingStatus} />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.priority}
                  </TableCell>
                  {role !== "SALESPERSON" ? (
                    <TableCell>{lead.assignedManager?.name ?? "—"}</TableCell>
                  ) : null}
                  <TableCell>{lead.owner?.name ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${lead.firstName}`}
                        onClick={() => setEditingLeadId(lead.id)}
                      >
                        <Pencil />
                      </Button>
                      {role === "ADMIN" ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${lead.firstName}`}
                          onClick={() =>
                            setDeletingLead({
                              id: lead.id,
                              name: `${lead.firstName} ${lead.lastName ?? ""}`.trim(),
                            })
                          }
                        >
                          <Trash2 className="text-destructive" />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            Page{" "}
            <span className="font-semibold text-foreground">
              {pagination.page}
            </span>{" "}
            of {pagination.totalPages} · {pagination.total} leads
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <EditLeadDialog
        leadId={editingLeadId}
        open={editingLeadId !== null}
        onOpenChange={(next) => {
          if (!next) setEditingLeadId(null);
        }}
        onDone={() => setEditingLeadId(null)}
      />
      <DeleteLeadDialog
        lead={deletingLead}
        open={deletingLead !== null}
        onOpenChange={(next) => {
          if (!next) setDeletingLead(null);
        }}
        onDeleted={() => setDeletingLead(null)}
      />
    </div>
  );
}
