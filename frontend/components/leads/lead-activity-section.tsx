"use client";

import { useState } from "react";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { orderDetailHref } from "@/components/orders/orders-table";
import { useCustomerAudit } from "@/hooks/useAudit";
import type { ActivityType, AuditEntry } from "@/lib/api-client/types/audit.types";

/**
 * Backed by the existing per-lead audit trail (`GET /customers/:leadId/audit`,
 * `useCustomerAudit`) — the same endpoint the Customer 360 timeline uses. It
 * works for any lead, not only ones that have placed an order.
 *
 * There is no dedicated calls/follow-ups API yet, so those tabs read the same
 * feed filtered by activity type (CALL, TASK) rather than a separate,
 * not-yet-built endpoint. The list has no server-side type filter, so
 * filtering happens client-side over the currently loaded page; pagination
 * therefore only applies to the "All" tab, where the counts are accurate.
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

function matchesTab(entry: AuditEntry, tab: ActivityTab): boolean {
  switch (tab) {
    case "ALL":
      return true;
    case "CALLS":
      return entry.type === "CALL";
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

const PAGE_SIZE = 25;

export function LeadActivitySection({ leadId }: { leadId: string }) {
  const [tab, setTab] = useState<ActivityTab>("ALL");
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useCustomerAudit(leadId, { page, pageSize: PAGE_SIZE });

  const entries = data?.items.filter((entry) => matchesTab(entry, tab)) ?? [];

  function handleTabChange(next: ActivityTab) {
    setTab(next);
    setPage(1);
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
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Inbox className="size-7 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{EMPTY_MESSAGES[tab]}</p>
          </div>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {entries.map((entry) => (
              <li key={entry.id} className="relative">
                <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">{describeActivity(entry.type)}</p>
                <p className="text-sm font-medium">{entry.title ?? describeActivity(entry.type)}</p>
                {entry.description ? <p className="text-sm text-muted-foreground">{entry.description}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {new Date(entry.occurredAt).toLocaleString()}
                  {entry.actor ? ` · ${entry.actor.name}` : null}
                  {entry.order ? (
                    <>
                      {" · "}
                      <Link href={orderDetailHref(entry.order.id)} className="hover:underline">
                        Order {entry.order.orderNumber}
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        )}

        {tab === "ALL" && data ? (
          <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={isLoading} />
        ) : null}
      </CardContent>
    </Card>
  );
}
