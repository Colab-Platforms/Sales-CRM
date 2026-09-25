"use client";

import { useState } from "react";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { orderDetailHref } from "@/components/orders/orders-table";
import { callDetailHref } from "@/components/calling/call-history-table";
import { useCustomerAudit } from "@/hooks/useAudit";
import { useCustomerTimeline } from "@/hooks/useCustomers";
import type { ActivityType, AuditEntry } from "@/lib/api-client/types/audit.types";
import type { TimelineEntry } from "@/lib/api-client/types/customers.types";

/**
 * All/WhatsApp/Follow-ups/Orders are backed by the per-lead audit trail (`GET
 * /customers/:leadId/audit`, `useCustomerAudit`). Calls is backed by `GET
 * /customers/:leadId/timeline` (`useCustomerTimeline`) instead — the only existing endpoint that
 * reads real Call rows (status/duration/direction/agent), rather than a generic activity-log line.
 * Both endpoints currently error for every lead (a database migration gap unrelated to calls
 * themselves — see the Call History README/report); when that's fixed this starts working with no
 * further change.
 *
 * Neither list has a server-side type filter, so filtering happens client-side over the currently
 * loaded page; pagination is therefore only shown for the "All" tab, where the count is accurate.
 */

type ActivityTab = "ALL" | "CALLS" | "WHATSAPP" | "FOLLOWUPS" | "ORDERS";

const TABS: { id: ActivityTab; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "CALLS", label: "Calls" },
  { id: "WHATSAPP", label: "WhatsApp" },
  { id: "FOLLOWUPS", label: "Follow-ups" },
  { id: "ORDERS", label: "Orders" },
];

const EMPTY_MESSAGES: Record<ActivityTab, string> = {
  ALL: "No activity yet.",
  CALLS: "No calls yet.",
  WHATSAPP: "No WhatsApp messages yet.",
  FOLLOWUPS: "No follow-ups yet.",
  ORDERS: "No orders yet.",
};

function matchesTab(entry: AuditEntry, tab: Exclude<ActivityTab, "CALLS">): boolean {
  switch (tab) {
    case "ALL":
      return true;
    case "WHATSAPP":
      return entry.type.startsWith("WHATSAPP_");
    case "FOLLOWUPS":
      return entry.type === "TASK";
    case "ORDERS":
      return entry.order !== null || entry.type.startsWith("ORDER_");
  }
}

// Friendlier copy for the common types; anything else falls back to a humanized version of the raw enum.
const ACTIVITY_LABELS: Partial<Record<ActivityType, string>> = {
  LEAD_CREATED: "Lead created",
  LEAD_UPDATED: "Lead updated",
  ASSIGNMENT: "Assigned",
  REASSIGNMENT: "Reassigned",
  CALL: "Call",
  NOTE: "Note",
  STATUS_CHANGE: "Status change",
  INTERESTED: "Marked interested",
  INTERESTED_EXPIRED: "Interest expired",
  TASK: "Follow-up",
  ORDER_CREATED: "Order created",
  ORDER_CONFIRMED: "Order confirmed",
  ORDER_STATUS_CHANGED: "Order status changed",
  ORDER_CANCELLED: "Order cancelled",
  WHATSAPP_MESSAGE_SENT: "WhatsApp sent",
  WHATSAPP_MESSAGE_RECEIVED: "WhatsApp received",
  WHATSAPP_DELIVERED: "WhatsApp delivered",
  WHATSAPP_READ: "WhatsApp read",
  WHATSAPP_FAILED: "WhatsApp failed",
};

function describeActivity(type: ActivityType): string {
  return ACTIVITY_LABELS[type] ?? type.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Common shape both the audit feed and the timeline feed get mapped into, so the list renders once. */
interface ActivityRow {
  id: string;
  label: string;
  title: string;
  description: string | null;
  occurredAt: string | Date;
  actorName: string | null;
  orderLink: { id: string; orderNumber: string } | null;
  /** Only set for a Calls-tab row — the real Call id (entry.id is "call:<uuid>"), for the View link. */
  callId: string | null;
}

function auditEntryToRow(entry: AuditEntry): ActivityRow {
  return {
    id: entry.id,
    label: describeActivity(entry.type),
    title: entry.title ?? describeActivity(entry.type),
    description: entry.description,
    occurredAt: entry.occurredAt,
    actorName: entry.actor?.name ?? null,
    orderLink: entry.order,
    callId: null,
  };
}

function timelineEntryToRow(entry: TimelineEntry): ActivityRow {
  return {
    id: entry.id,
    label: "Call",
    title: entry.title,
    description: entry.description,
    occurredAt: entry.occurredAt,
    actorName: entry.actor?.name ?? null,
    orderLink: null,
    callId: entry.id.startsWith("call:") ? entry.id.slice("call:".length) : null,
  };
}

const PAGE_SIZE = 25;

export function LeadActivitySection({ leadId }: { leadId: string }) {
  const [tab, setTab] = useState<ActivityTab>("ALL");
  const [auditPage, setAuditPage] = useState(1);
  const [callsPage, setCallsPage] = useState(1);

  const audit = useCustomerAudit(leadId, { page: auditPage, pageSize: PAGE_SIZE });
  const calls = useCustomerTimeline(leadId, { page: callsPage, pageSize: PAGE_SIZE });

  const isCallsTab = tab === "CALLS";
  const isLoading = isCallsTab ? calls.isLoading : audit.isLoading;
  const error = isCallsTab ? calls.error : audit.error;
  const rows: ActivityRow[] = isCallsTab
    ? (calls.data?.entries.filter((entry) => entry.type === "CALL").map(timelineEntryToRow) ?? [])
    : (audit.data?.items.filter((entry) => matchesTab(entry, tab)).map(auditEntryToRow) ?? []);

  function handleTabChange(next: ActivityTab) {
    setTab(next);
    setAuditPage(1);
    setCallsPage(1);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="tablist" aria-label="Activity type" className="flex flex-wrap gap-2">
          {TABS.map((t) => {
            const isActive = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabChange(t.id)}
                className={cn(
                  "sketch-press inline-flex h-8 items-center rounded-[10px_8px_11px_8px] border-[1.5px] px-3 text-[0.8rem] font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  isActive
                    ? "border-ink-line bg-primary text-primary-foreground"
                    : "border-ink-line/50 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading activity">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Inbox className="size-7 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{EMPTY_MESSAGES[tab]}</p>
          </div>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {rows.map((row) => (
              <li key={row.id} className="relative">
                <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">{row.label}</p>
                <p className="text-sm font-medium">{row.title}</p>
                {row.description ? <p className="text-sm text-muted-foreground">{row.description}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {new Date(row.occurredAt).toLocaleString()}
                  {row.actorName ? ` · ${row.actorName}` : null}
                  {row.orderLink ? (
                    <>
                      {" · "}
                      <Link href={orderDetailHref(row.orderLink.id)} className="hover:underline">
                        Order {row.orderLink.orderNumber}
                      </Link>
                    </>
                  ) : null}
                  {row.callId ? (
                    <>
                      {" · "}
                      <Link href={callDetailHref(row.callId)} className="hover:underline">
                        View call
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        )}

        {tab === "ALL" && audit.data ? (
          <OrdersPagination pagination={audit.data.pagination} onPageChange={setAuditPage} disabled={audit.isFetching} />
        ) : null}
      </CardContent>
    </Card>
  );
}
