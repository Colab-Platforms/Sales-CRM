"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getErrorMessage } from "@/lib/api-client/client";
import { ticketListQueryOptions } from "@/lib/api-client/queries/tickets.queries";
import { formatDateTime } from "@/lib/order-status";
import { TICKET_CATEGORY_LABELS } from "@/lib/ticket-status";
import { useAuthStore } from "@/stores/auth-store";
import type { TicketStatus } from "@/lib/api-client/types/tickets.types";
import { RaiseTicketDialog } from "./raise-ticket-dialog";
import { TicketDetailDialog } from "./ticket-detail-dialog";
import { TicketPriorityBadge, TicketStatusBadge } from "./ticket-badges";

type Filter = TicketStatus | "ALL";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
  { value: "ALL", label: "All" },
];

/** Support tickets. A salesperson raises and follows their own; a manager works their team's; an admin sees all. */
export function TicketsView() {
  const user = useAuthStore((s) => s.user);
  const isSalesperson = user?.role === "SALESPERSON";
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [raising, setRaising] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery(ticketListQueryOptions({ status: filter === "ALL" ? undefined : filter, page: 1, pageSize: 50 }));
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={isSalesperson ? "My Tickets" : "Support Tickets"}
        description={isSalesperson ? "Raise a ticket for any difficulty or problem you face, and track its progress." : "Problems raised by the team. Reply, and mark them resolved when done."}
        actions={
          isSalesperson ? (
            <Button type="button" onClick={() => setRaising(true)}>
              <Plus className="size-4" /> Raise ticket
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Status">
        {FILTERS.map((f) => (
          <Button key={f.value} type="button" size="sm" variant={filter === f.value ? "default" : "outline"} role="tab" aria-selected={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>
      {list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(list.error, "Could not load tickets.")}
        </p>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {list.isPending ? (
            <p className="p-4 text-sm text-muted-foreground">Loading tickets…</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No tickets here.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Subject</th>
                    {!isSalesperson ? <th className="px-3 py-2 font-medium">Raised by</th> : null}
                    <th className="px-3 py-2 font-medium">Category</th>
                    <th className="px-3 py-2 font-medium">Priority</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Raised</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id} className="cursor-pointer border-b align-top hover:bg-muted/40" onClick={() => setOpenId(t.id)}>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{t.ticketNumber}</td>
                      <td className="max-w-[22rem] px-3 py-2 break-words">
                        <button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => setOpenId(t.id)}>
                          {t.subject}
                        </button>
                        {t.commentCount > 0 ? <span className="block text-xs text-muted-foreground">{t.commentCount} repl{t.commentCount === 1 ? "y" : "ies"}</span> : null}
                      </td>
                      {!isSalesperson ? <td className="px-3 py-2">{t.raisedBy.name}</td> : null}
                      <td className="px-3 py-2 text-xs text-muted-foreground">{TICKET_CATEGORY_LABELS[t.category]}</td>
                      <td className="px-3 py-2">
                        <TicketPriorityBadge priority={t.priority} />
                      </td>
                      <td className="px-3 py-2">
                        <TicketStatusBadge status={t.status} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {isSalesperson ? <RaiseTicketDialog open={raising} onOpenChange={setRaising} /> : null}
      {openId ? <TicketDetailDialog ticketId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
