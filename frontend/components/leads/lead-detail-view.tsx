"use client";

import axios from "axios";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  History,
  NotebookPen,
  Pencil,
  Phone,
  PhoneCall,
  SearchX,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { LeadStatusSelect } from "@/components/leads/lead-table";
import { CustomerTimeline } from "@/components/customers/customer-timeline";
import { CallCustomerDialog } from "@/components/calling/call-customer-dialog";
import { CallStatusCard } from "@/components/calling/call-status-card";
import { useCallCustomer } from "@/hooks/useCallCustomer";
import { AssignmentHistoryCard } from "./assignment-history-card";
import { EditLeadDialog } from "./edit-lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";
import { ClickToCallButton, CallHistoryEntry } from "./calling";
import { leadDetailQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { abandonmentByLeadQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { AbandonmentPanel } from "@/components/abandonment/abandonment-panel";
import { getErrorMessage } from "@/lib/api-client/client";
import { formatDateTime } from "@/lib/order-status";
import { LEAD_PRIORITY_LABELS } from "@/lib/customer-status";

const LEADS_HREF = "/dashboard/leads";

function BackLink() {
  return (
    <Link
      href={LEADS_HREF}
      className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-card px-3 py-1.5 text-xs font-bold text-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-muted"
    >
      <ArrowLeft className="size-3.5" />
      <span>Back to leads</span>
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading lead dossier">
      <Skeleton className="h-9 w-44 rounded-xl" />
      <Skeleton className="h-44 rounded-2xl" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Skeleton className="h-80 rounded-2xl lg:col-span-5" />
        <Skeleton className="h-80 rounded-2xl lg:col-span-7" />
      </div>
    </div>
  );
}

function NotFoundState() {
  return (
    <div className="space-y-4">
      <BackLink />
      <div role="alert" className="sketch-outline flex flex-col items-start gap-3 bg-card/60 p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <SearchX className="size-5" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">Lead not found</p>
        </div>
        <p className="text-sm text-muted-foreground">
          This lead may have been removed, or you may not have access to it.
        </p>
        <BackLink />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-4">
      <BackLink />
      <div role="alert" className="sketch-panel flex flex-col items-start gap-3 bg-card p-6">
        <p className="text-sm font-semibold text-destructive">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="sketch-press rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)]"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export function LeadDetailView({ leadId }: { leadId: string }) {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.user);
  const role = currentUser?.role;

  // Called unconditionally, ahead of the lead-loading early returns below (Rules of Hooks) — it
  // only needs `leadId`, which is available immediately as a prop. This also means a call that's
  // still in flight survives a lead refetch/re-render instead of being reset by it.
  const call = useCallCustomer(leadId);
  const { data: lead, isPending, error, refetch } = useQuery(leadDetailQueryOptions(leadId));
  const { data: abandonment } = useQuery(abandonmentByLeadQueryOptions(leadId));
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"calls" | "timeline" | "assignments" | "abandonment">("calls");

  if (isPending) return <DetailSkeleton />;

  if (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return <NotFoundState />;
    }
    return <ErrorState message={getErrorMessage(error, "Failed to load lead.")} onRetry={() => refetch()} />;
  }

  if (!lead) return <NotFoundState />;

  const name = `${lead.firstName} ${lead.lastName ?? ""}`.trim();

  return (
    <div className="space-y-5">
      {/* Top Bar: Back Link & Doodle Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={call.openDialog}
            disabled={!lead.mobile}
            title={lead.mobile ? undefined : "This lead has no mobile number on file."}
            className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Phone className="size-3.5" />
            <span>Call Customer</span>
          </button>

          {/* WhatsApp stays presentational, per this step's scope — only Call Customer is wired to a
              real backend call. Neither button ever talks to a telephony provider directly; the
              frontend only ever calls our own POST /api/calls. */}
          <Button variant="outline" onClick={() => toast.info("WhatsApp messaging is coming soon.")}>
            WhatsApp
          </Button>

          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-card px-3.5 py-1.5 text-xs font-bold text-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-muted"
          >
            <Pencil className="size-3.5 text-primary" />
            <span>Edit Lead</span>
          </button>

          <Link
            href={`/dashboard/customers/${lead.id}`}
            className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-card px-3.5 py-1.5 text-xs font-bold text-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-muted"
          >
            <ExternalLink className="size-3.5 text-primary" />
            <span>Customer 360</span>
          </Link>

          {role === "ADMIN" ? (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-destructive/60 bg-destructive/10 px-3 py-1.5 text-xs font-bold text-destructive shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-destructive/20"
            >
              <Trash2 className="size-3.5" />
              <span>Delete</span>
            </button>
          ) : null}
        </div>
      </div>

      {call.result ? (
        <CallStatusCard
          status={call.result.status}
          customerName={name}
          callId={call.result.callId}
          callingIdentity={call.result.callingIdentity}
          onDismiss={call.dismissResult}
        />
      ) : null}

      {/* Dossier Header Card: Clean Sketch Header */}
      <div className="sketch-panel relative overflow-hidden bg-card p-5">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Lead Details
                </p>
                <h1 className="sketch-underline font-heading text-2xl font-black tracking-tight text-foreground sm:text-3xl">
                  {name}
                </h1>
              </div>

              <div className="rotate-[-1deg]">
                <StatusBadge status={lead.workingStatus} className="border-[1.5px] border-ink-line font-bold" />
              </div>

              <Badge
                variant="outline"
                className="rotate-1 border-[1.5px] border-ink-line-soft bg-muted/40 font-mono text-[11px] font-bold"
              >
                ★ {LEAD_PRIORITY_LABELS[lead.priority]}
              </Badge>

              {role === "SALESPERSON" ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Change status:</span>
                  <LeadStatusSelect lead={lead} />
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <span className="sketch-outline rounded-[10px_8px_11px_8px] bg-muted/30 px-2.5 py-1 font-mono text-xs font-bold text-foreground">
                #{lead.leadNumber}
              </span>
            </div>
          </div>

          {/* Compact Quick-Stats Ribbon */}
          <div className="grid grid-cols-2 gap-3 border-t-[1.5px] border-dashed border-ink-line-soft pt-3 sm:grid-cols-3 md:grid-cols-6">
            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">Phone</p>
              <div className="flex items-center gap-1">
                <span className="truncate text-xs font-bold">{lead.mobile ?? "—"}</span>
                <ClickToCallButton lead={lead} />
              </div>
            </div>

            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">Email</p>
              <p className="truncate text-xs font-semibold" title={lead.email ?? ""}>
                {lead.email ?? "—"}
              </p>
            </div>

            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">Location</p>
              <p className="truncate text-xs font-semibold">{lead.location ?? "—"}</p>
            </div>

            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">Salesperson</p>
              <p className="truncate text-xs font-bold text-primary">{lead.owner?.name ?? "Unassigned"}</p>
            </div>

            {role !== "SALESPERSON" ? (
              <div className="space-y-0.5">
                <p className="text-[11px] font-medium text-muted-foreground">Manager</p>
                <p className="truncate text-xs font-semibold">{lead.assignedManager?.name ?? "—"}</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                <p className="text-[11px] font-medium text-muted-foreground">Source</p>
                <p className="truncate text-xs font-semibold">{lead.source?.name ?? "Direct"}</p>
              </div>
            )}

            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">Created</p>
              <p className="truncate text-xs text-muted-foreground">{formatDateTime(lead.createdAt)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Two-Column Compact Dossier Workspace */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
        {/* Left Column (5 cols): Requirement Brief & Lead Info */}
        <div className="space-y-4 lg:col-span-5">
          <div className="sketch-panel space-y-3 bg-card p-4.5">
            <div className="flex items-center justify-between border-b-[1.5px] border-ink-line-soft pb-2">
              <div className="flex items-center gap-2">
                <NotebookPen className="size-4 text-primary" />
                <h2 className="font-heading text-sm font-extrabold text-foreground">Requirement Brief</h2>
              </div>
              <span className="text-xs text-muted-foreground">Client Memo</span>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
              <p className="text-sm leading-relaxed text-foreground">
                {lead.requirement?.trim() ? lead.requirement.trim() : "No specific customer requirement noted yet."}
              </p>
            </div>

            <div className="space-y-2 pt-1 text-xs">
              <div className="flex items-center justify-between border-b border-border/50 py-1.5">
                <span className="text-muted-foreground">Lead Source:</span>
                <span className="font-bold text-foreground">{lead.source?.name ?? "Direct / Organic"}</span>
              </div>
              <div className="flex items-center justify-between border-b border-border/50 py-1.5">
                <span className="text-muted-foreground">Assigned Team Group:</span>
                <span className="font-bold text-foreground">{lead.group?.name ?? "General Pool"}</span>
              </div>
              <div className="flex items-center justify-between border-b border-border/50 py-1.5">
                <span className="text-muted-foreground">Last Activity Touched:</span>
                <span className="font-mono text-muted-foreground">{formatDateTime(lead.updatedAt)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column (7 cols): Doodle Binder Workspace with Tabs */}
        <div className="space-y-0 lg:col-span-7">
          <div className="flex items-center gap-1.5 border-b-[2px] border-ink-line px-2">
            <button
              type="button"
              onClick={() => setActiveTab("calls")}
              className={`sketch-press flex items-center gap-1.5 rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
                activeTab === "calls"
                  ? "-mb-[2px] border-b-card bg-card pb-2.5 text-foreground shadow-[0_-2px_0_0_var(--sketch-shadow)]"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Phone className="size-3.5" />
              <span>Calls &amp; Feedback</span>
              <span className="rounded-full bg-primary/15 px-1.5 py-0.2 font-mono text-[10px] font-bold text-primary">
                {lead.calls.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("timeline")}
              className={`sketch-press flex items-center gap-1.5 rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
                activeTab === "timeline"
                  ? "-mb-[2px] border-b-card bg-card pb-2.5 text-foreground shadow-[0_-2px_0_0_var(--sketch-shadow)]"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Clock className="size-3.5" />
              <span>Activity Timeline</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("assignments")}
              className={`sketch-press flex items-center gap-1.5 rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
                activeTab === "assignments"
                  ? "-mb-[2px] border-b-card bg-card pb-2.5 text-foreground shadow-[0_-2px_0_0_var(--sketch-shadow)]"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <History className="size-3.5" />
              <span>Assignment Trail</span>
            </button>

            {abandonment ? (
              <button
                type="button"
                onClick={() => setActiveTab("abandonment")}
                className={`sketch-press flex items-center gap-1.5 rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
                  activeTab === "abandonment"
                    ? "-mb-[2px] border-b-card bg-card pb-2.5 text-foreground shadow-[0_-2px_0_0_var(--sketch-shadow)]"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <ShoppingCart className="size-3.5" />
                <span>Abandoned Checkout</span>
              </button>
            ) : null}
          </div>

          <div className="sketch-panel rounded-t-none border-t-0 bg-card p-4.5">
            {activeTab === "calls" ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <PhoneCall className="size-4 text-primary" />
                    <h3 className="font-heading text-sm font-extrabold">Calls &amp; Outcomes</h3>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Call line:</span>
                    <ClickToCallButton lead={lead} />
                  </div>
                </div>

                {lead.calls.length === 0 ? (
                  <div className="sketch-dashed flex flex-col items-center justify-center p-8 text-center">
                    <Phone className="size-8 text-muted-foreground/50" />
                    <p className="mt-2 text-sm font-bold text-foreground">No calls logged yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Use the Call Customer button above to start your first call with {lead.firstName}.
                    </p>
                  </div>
                ) : (
                  <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
                    {lead.calls.map((call) => (
                      <CallHistoryEntry key={call.id} leadId={lead.id} call={call} />
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {activeTab === "timeline" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <Clock className="size-4 text-primary" />
                    <h3 className="font-heading text-sm font-extrabold">Customer Timeline</h3>
                  </div>
                  <span className="text-xs text-muted-foreground">All actions recorded</span>
                </div>

                <div className="max-h-[520px] overflow-y-auto pr-1">
                  <CustomerTimeline leadId={lead.id} bare />
                </div>
              </div>
            ) : null}

            {activeTab === "assignments" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <History className="size-4 text-primary" />
                    <h3 className="font-heading text-sm font-extrabold">Ownership &amp; Assignment Trail</h3>
                  </div>
                  <span className="text-xs text-muted-foreground">Transfer audit</span>
                </div>

                <div className="max-h-[520px] overflow-y-auto pr-1">
                  <AssignmentHistoryCard leadId={lead.id} bare />
                </div>
              </div>
            ) : null}

            {activeTab === "abandonment" && abandonment ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="size-4 text-primary" />
                    <h3 className="font-heading text-sm font-extrabold">Abandoned Checkout</h3>
                  </div>
                  <span className="text-xs text-muted-foreground">Cart &amp; recovery details</span>
                </div>

                <div className="max-h-[520px] overflow-y-auto pr-1">
                  <AbandonmentPanel abandonment={abandonment} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <CallCustomerDialog
        open={call.dialogOpen}
        onOpenChange={(open) => {
          if (!open) call.closeDialog();
        }}
        customerName={name}
        customerMobile={lead.mobile}
        isPending={call.isPending}
        failure={call.failure}
        onStartCall={call.startCall}
        onRetry={call.retry}
      />

      <EditLeadDialog leadId={lead.id} open={editOpen} onOpenChange={setEditOpen} onDone={() => setEditOpen(false)} />
      <DeleteLeadDialog
        lead={{ id: lead.id, name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push(LEADS_HREF)}
      />
    </div>
  );
}
