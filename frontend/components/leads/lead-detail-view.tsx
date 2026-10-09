"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  History,
  MessageCircle,
  NotebookPen,
  Pencil,
  Phone,
  PhoneCall,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { CustomerTimeline } from "@/components/customers/customer-timeline";
import { SendWhatsAppDialog } from "@/components/whatsapp/send-whatsapp-dialog";
import { CreateOrderDialog } from "@/components/whatsapp/inbox/create-order-dialog";
import { AssignmentHistoryCard } from "./assignment-history-card";
import { EditLeadDialog } from "./edit-lead-dialog";
import { DeleteLeadDialog } from "./delete-lead-dialog";
import { ClickToCallButton, CallHistoryEntry } from "./calling";
import { useAuthStore } from "@/stores/auth-store";
import { leadDetailQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { leadCallsQueryOptions } from "@/lib/api-client/queries/calling.queries";
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

function LeadDetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading lead dossier">
      <Skeleton className="h-9 w-44 rounded-xl" />
      <Skeleton className="h-44 rounded-2xl" />
      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-12">
        <Skeleton className="h-80 rounded-2xl @4xl:col-span-4" />
        <Skeleton className="h-80 rounded-2xl @4xl:col-span-8" />
      </div>
    </div>
  );
}

export function LeadDetailView({ leadId }: { leadId: string }) {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.user);
  const role = currentUser?.role;

  const { data: lead, isLoading, error, refetch } = useQuery(leadDetailQueryOptions(leadId));
  const { data: abandonment } = useQuery(abandonmentByLeadQueryOptions(leadId));
  // Dedicated calls query, not `lead.calls` - it's the endpoint that already selects `transcript` and
  // polls while one is still transcribing (leadCallsQueryOptions), same one the table's call-history
  // popup uses. `lead.calls` (from the Lead fetch above) never carried transcript data at all.
  const { data: calls = [] } = useQuery({ ...leadCallsQueryOptions(leadId), enabled: Boolean(lead) });
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"calls" | "timeline" | "assignments" | "abandonment">("calls");
  const [sendWhatsAppOpen, setSendWhatsAppOpen] = useState(false);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);

  if (isLoading) return <LeadDetailSkeleton />;

  if (error || !lead) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div role="alert" className="sketch-panel flex flex-col items-start gap-3 bg-card p-6">
          <p className="text-sm font-semibold text-destructive">{getErrorMessage(error, "Failed to load lead.")}</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="sketch-press rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const name = `${lead.firstName} ${lead.lastName ?? ""}`.trim();

  return (
    <div className="@container space-y-5">
      {/* Top Bar: Back Link & Doodle Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink />

        <div className="flex flex-wrap items-center gap-2">
          {/* Reuses the exact same Send WhatsApp dialog/provider-agnostic template send flow Customer
              360 and the WhatsApp Inbox already use - never a second messaging path. Only shown when
              there's a real number to send to. */}
          {lead.mobile ? (
            <button
              type="button"
              onClick={() => setSendWhatsAppOpen(true)}
              className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-primary/90"
            >
              <MessageCircle className="size-3.5" />
              <span>Send WhatsApp</span>
            </button>
          ) : null}

          {/* Reuses the exact same Create Order dialog/flow (product+variant selection, address
              prefill via the customer's last order, COD/prepaid, Cashfree payment-link generation,
              Shopify push) the WhatsApp Inbox's "Create Order" action already uses - never a second
              order-creation implementation. leadId/customerName/customerMobile are the same generic
              props that dialog already takes; only the entry point differs. */}
          <button
            type="button"
            onClick={() => setCreateOrderOpen(true)}
            className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-card px-3.5 py-1.5 text-xs font-bold text-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-muted"
          >
            <ShoppingCart className="size-3.5 text-primary" />
            <span>Create Order</span>
          </button>

          {/* Tactile Doodle Edit Button */}
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-card px-3.5 py-1.5 text-xs font-bold text-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-muted"
          >
            <Pencil className="size-3.5 text-primary" />
            <span>Edit Lead</span>
          </button>

          {/* Customer 360 link as doodle chip */}
          <Link
            href={`/dashboard/customers/${lead.id}`}
            className="sketch-press inline-flex items-center gap-1.5 rounded-[11px_9px_12px_9px] border-[1.5px] border-ink-line bg-card px-3.5 py-1.5 text-xs font-bold text-foreground shadow-[2px_2px_0_0_var(--sketch-shadow)] hover:bg-muted"
          >
            <ExternalLink className="size-3.5 text-primary" />
            <span>Customer 360</span>
          </Link>

          {/* Tactile Delete button for Admin only */}
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

              {/* Rubber ink stamp for working status */}
              <div className="rotate-[-1deg]">
                <StatusBadge status={lead.workingStatus} className="border-[1.5px] border-ink-line font-bold" />
              </div>

              {/* Priority doodle badge */}
              <Badge
                variant="outline"
                className="rotate-1 border-[1.5px] border-ink-line-soft bg-muted/40 font-mono text-[11px] font-bold"
              >
                ★ {LEAD_PRIORITY_LABELS[lead.priority]}
              </Badge>
            </div>

            {/* Lead Number */}
            <div className="flex items-center gap-2">
              <span className="sketch-outline rounded-[10px_8px_11px_8px] bg-muted/30 px-2.5 py-1 font-mono text-xs font-bold text-foreground">
                #{lead.leadNumber}
              </span>
            </div>
          </div>

          {/* Compact Quick-Stats Ribbon */}
          <div className="grid grid-cols-2 gap-3 border-t-[1.5px] border-dashed border-ink-line-soft pt-3 sm:grid-cols-3 @6xl:grid-cols-6">
            <div className="min-w-0 space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">Phone</p>
              <div className="flex flex-wrap items-center gap-1">
                <span className="shrink-0 text-xs font-bold">{lead.mobile ?? "—"}</span>
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
      <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
        {/* Left Column (5 cols): Requirement Brief & Lead Info */}
        <div className="min-w-0 space-y-4 @4xl:col-span-4">
          <div className="sketch-panel space-y-3 bg-card p-4.5">
            <div className="flex items-center justify-between border-b-[1.5px] border-ink-line-soft pb-2">
              <div className="flex items-center gap-2">
                <NotebookPen className="size-4 text-primary" />
                <h2 className="font-heading text-sm font-extrabold text-foreground">Requirement Brief</h2>
              </div>
              <span className="text-xs text-muted-foreground">Client Memo</span>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
              <p className="break-words text-sm leading-relaxed text-foreground">
                {lead.requirement?.trim() ? lead.requirement.trim() : "No specific customer requirement noted yet."}
              </p>
            </div>

            {/* Quick Metadata Grid */}
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
        <div className="min-w-0 space-y-0 @4xl:col-span-8">
          {/* Doodle Binder Tabs Bar */}
          <div className="flex items-center gap-1.5 overflow-x-auto border-b-[2px] border-ink-line px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={() => setActiveTab("calls")}
              className={`sketch-press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
                activeTab === "calls"
                  ? "-mb-[2px] border-b-card bg-card pb-2.5 text-foreground shadow-[0_-2px_0_0_var(--sketch-shadow)]"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Phone className="size-3.5" />
              <span>Calls &amp; Feedback</span>
              <span className="rounded-full bg-primary/15 px-1.5 py-0.2 font-mono text-[10px] font-bold text-primary">
                {calls.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("timeline")}
              className={`sketch-press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
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
              className={`sketch-press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
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
                className={`sketch-press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-[12px_10px_0_0] border-[1.5px] border-b-0 border-ink-line px-4 py-2 text-xs font-extrabold transition-all ${
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

          {/* Tab Content Pane: Neat, Bounded & Scroll-Friendly */}
          <div className="sketch-panel rounded-t-none border-t-0 bg-card p-4.5">
            {/* TAB 1: Calls & Feedback */}
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

                {calls.length === 0 ? (
                  <div className="sketch-dashed flex flex-col items-center justify-center p-8 text-center">
                    <Phone className="size-8 text-muted-foreground/50" />
                    <p className="mt-2 text-sm font-bold text-foreground">No calls logged yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Use the phone button above to start your first call with {lead.firstName}.
                    </p>
                  </div>
                ) : (
                  <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
                    {calls.map((call) => (
                      <CallHistoryEntry key={call.id} leadId={lead.id} call={call} currentFollowUp={lead.tasks[0]} />
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {/* TAB 2: Activity Timeline */}
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

            {/* TAB 3: Assignment Trail */}
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

            {/* TAB 4: Abandoned Checkout - only present when this lead came from (or has) an abandoned cart */}
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

      {/* Edit & Delete Dialogs */}
      <EditLeadDialog leadId={lead.id} open={editOpen} onOpenChange={setEditOpen} onDone={() => setEditOpen(false)} />
      <DeleteLeadDialog
        lead={{ id: lead.id, name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push(LEADS_HREF)}
      />
      {/* No order list loaded on this page - the dialog's own order-selection step is already
          optional and stays hidden whenever there are none, exactly as it does for a customer with
          no orders yet on Customer 360. */}
      <SendWhatsAppDialog open={sendWhatsAppOpen} onOpenChange={setSendWhatsAppOpen} leadId={lead.id} customerName={name} orders={[]} />
      <CreateOrderDialog open={createOrderOpen} onOpenChange={setCreateOrderOpen} leadId={lead.id} customerName={name} customerMobile={lead.mobile} />
    </div>
  );
}
