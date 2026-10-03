"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, Phone } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Inbox, Pencil, Trash2, History, ArrowRight } from "lucide-react";
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
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { useUpdateLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import { useInitiateCallMutation } from "@/lib/api-client/mutations/calling.mutations";
import { virtualNumbersQueryOptions, leadCallsQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { ScheduleFollowUpDialog } from "@/components/follow-ups/schedule-follow-up-dialog";
import {
  FOLLOW_UP_TYPE_LABEL,
  formatRelative,
  formatWhen,
} from "@/components/follow-ups/follow-up-utils";
import { useNow } from "@/components/follow-ups/use-now";
import { cn } from "@/lib/utils";
import { EditLeadDialog } from "./edit-lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";
import { ClickToCallButton, CallHistoryEntry } from "./calling";
import type {
  Lead,
  LeadListPagination,
} from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

// Every history-showing surface (this table's popup, the lead detail page) links back to a single
// per-lead page, so a salesperson's "My Leads" list stops routing into the unrelated Customer 360
// view and instead lands somewhere that actually shows this lead's own assignment/call history.
export function leadDetailHref(leadId: string) {
  return `/dashboard/leads/${leadId}`;
}

const CALL_HISTORY_PREVIEW_COUNT = 5;

// Minimal shape this popup needs off a lead - satisfied structurally by both the full Lead type
// (leads pages) and AbandonmentListItem.lead (abandoned-leads pages), so both reuse the exact same
// call-history/outcome UI instead of the abandoned-leads queue duplicating it. Calls are fetched
// here directly (leadCallsQueryOptions) rather than trusted from the caller's list data, which never
// carried `transcript` and never polled while one was still being generated.
export interface CallHistoryLead {
  id: string;
  firstName: string;
  lastName?: string | null;
  tasks: Lead["tasks"];
}

function CallHistoryDialogContent({ lead }: { lead: CallHistoryLead }) {
  const { data: calls = [], isPending } = useQuery(leadCallsQueryOptions(lead.id));
  // Calls already arrive newest-first from the API, so slicing the front gives the latest N.
  const recentCalls = calls.slice(0, CALL_HISTORY_PREVIEW_COUNT);
  const hiddenCount = calls.length - recentCalls.length;

  return (
    <DialogContent className="sm:max-w-140">
      <DialogHeader>
        <DialogTitle>
          {lead.firstName} {lead.lastName ?? ""} — Call History
        </DialogTitle>
        <DialogDescription>
          {hiddenCount > 0
            ? `Showing the ${recentCalls.length} most recent of ${calls.length} calls.`
            : "Click-to-call attempts logged for this lead."}
        </DialogDescription>
      </DialogHeader>
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : recentCalls.length === 0 ? (
        <p className="text-sm text-muted-foreground">No calls yet.</p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {recentCalls.map((call) => (
            <CallHistoryEntry key={call.id} leadId={lead.id} call={call} currentFollowUp={lead.tasks[0]} />
          ))}
        </div>
      )}
      {hiddenCount > 0 ? (
        <Link
          href={leadDetailHref(lead.id)}
          className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          View full history for this lead
          <ArrowRight className="size-3.5" />
        </Link>
      ) : null}
    </DialogContent>
  );
}

export function CallHistoryButton({ lead }: { lead: CallHistoryLead }) {
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

// function ClickToCallButton({ lead }: { lead: Lead }) {
//   const initiateCall = useInitiateCallMutation(lead.id);
//   const { data: virtualNumbers = [] } = useQuery(virtualNumbersQueryOptions());
//   const [virtualNumberId, setVirtualNumberId] = useState("");
//   const [activeCallId, setActiveCallId] = useState<string | null>(null);
//   const selected = virtualNumberId || virtualNumbers[0]?.id || "";

//   if (!lead.mobile) return null;

//   return (
//     <div className="flex items-center gap-1">
//       <NativeSelect
//         size="sm"
//         aria-label="Call from virtual number"
//         className="text-xs"
//         wrapperClassName="w-28"
//         value={selected}
//         disabled={initiateCall.isPending || virtualNumbers.length === 0}
//         onChange={(e) => setVirtualNumberId(e.target.value)}
//       >
//         {virtualNumbers.length === 0 ? <option value="">No line</option> : null}
//         {virtualNumbers.map((vn) => (
//           <option key={vn.id} value={vn.id}>
//             {vn.displayName ?? vn.number}
//           </option>
//         ))}
//       </NativeSelect>
//       <Button
//         variant="ghost"
//         size="icon"
//         className="size-6"
//         aria-label={`Call ${lead.firstName}`}
//         disabled={initiateCall.isPending || !selected}
//         onClick={() =>
//           initiateCall.mutate(selected, {
//             onSuccess: (result) => {
//               toast.success("Calling your phone now — hold on.");
//               setActiveCallId(result.callId);
//             },
//             onError: (error) =>
//               toast.error(getErrorMessage(error, "Failed to start call.")),
//           })
//         }
//       >
//         <Phone className="size-3.5" />
//       </Button>
//       {activeCallId ? (
//         <ActiveCallDialog
//           lead={lead}
//           currentFollowUp={lead.tasks[0]}
//           callId={activeCallId}
//           onClose={() => setActiveCallId(null)}
//         />
//       ) : null}
//     </div>
//   );
// }

/** The reminder set on a lead, under its status; click to move it. Shows the actual time, red once overdue. */
function LeadReminderChip({ lead }: { lead: Lead }) {
  const updateLead = useUpdateLeadMutation();
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);
  const reminder = lead.tasks[0];
  // Reminders only exist while the lead is in a call back / follow up status.
  if (
    !reminder ||
    (lead.workingStatus !== "CALL_BACK" && lead.workingStatus !== "FOLLOW_UP")
  )
    return null;
  const overdue = new Date(reminder.scheduledAt).getTime() < now;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${FOLLOW_UP_TYPE_LABEL[reminder.type]} · ${formatRelative(reminder.scheduledAt, now)} — click to reschedule`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:shadow-sm",
          overdue
            ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
            : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <AlarmClock className="size-3.5" />
        {formatWhen(reminder.scheduledAt)}
      </button>
      {open ? (
        <ScheduleFollowUpDialog
          reschedule
          kind={reminder.type === "CALLBACK" ? "CALL_BACK" : "FOLLOW_UP"}
          leadId={lead.id}
          leadName={`${lead.firstName} ${lead.lastName ?? ""}`.trim()}
          current={reminder}
          isPending={updateLead.isPending}
          onConfirm={(iso) =>
            updateLead.mutate(
              { id: lead.id, payload: { followUpAt: iso } },
              {
                onSuccess: () => {
                  toast.success("Reminder rescheduled.");
                  setOpen(false);
                },
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Failed to reschedule.")),
              },
            )
          }
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function LeadStatusSelect({ lead }: { lead: Lead }) {
  const updateLead = useUpdateLeadMutation();
  // Call back / follow up need a reminder time first, so they're held here until the dialog confirms.
  const [pendingFollowUp, setPendingFollowUp] = useState<
    "CALL_BACK" | "FOLLOW_UP" | null
  >(null);

  function save(workingStatus: LeadWorkingStatus, followUpAt?: string) {
    updateLead.mutate(
      { id: lead.id, payload: { workingStatus, followUpAt } },
      {
        onSuccess: () => {
          toast.success(
            followUpAt ? "Status updated — reminder set." : "Status updated.",
          );
          setPendingFollowUp(null);
        },
        onError: (error) =>
          toast.error(getErrorMessage(error, "Failed to update status.")),
      },
    );
  }

  return (
    <>
      <NativeSelect
        size="sm"
        aria-label={`Status for ${lead.firstName}`}
        value={lead.workingStatus}
        disabled={updateLead.isPending}
        wrapperClassName="w-40"
        onChange={(e) => {
          const next = e.target.value as LeadWorkingStatus;
          if (next === "CALL_BACK" || next === "FOLLOW_UP")
            setPendingFollowUp(next);
          else save(next);
        }}
      >
        {/* ASSIGNED is set by assigning a lead; only shown while the lead already has it (never for a salesperson). */}
        {STATUS_ORDER.filter(
          (status) =>
            status !== "ASSIGNED" || lead.workingStatus === "ASSIGNED",
        ).map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </NativeSelect>
      {pendingFollowUp ? (
        <ScheduleFollowUpDialog
          kind={pendingFollowUp}
          leadId={lead.id}
          leadName={`${lead.firstName} ${lead.lastName ?? ""}`.trim()}
          current={lead.tasks[0]}
          isPending={updateLead.isPending}
          onConfirm={(iso) => save(pendingFollowUp, iso)}
          onCancel={() => setPendingFollowUp(null)}
        />
      ) : null}
    </>
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
                      href={leadDetailHref(lead.id)}
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
                    <div className="flex flex-wrap items-center gap-2">
                      {role === "SALESPERSON" ? (
                        <LeadStatusSelect lead={lead} />
                      ) : (
                        <StatusBadge status={lead.workingStatus} />
                      )}
                      <LeadReminderChip lead={lead} />
                    </div>
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
