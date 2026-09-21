import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { orderDetailHref, customerDetailHref } from "@/components/orders/orders-table";
import { ActivityTypeBadge } from "./activity-type-badge";
import { AuditSourceBadge } from "./audit-source-badge";
import { formatDateTime } from "@/lib/order-status";
import type { AuditEntry } from "@/lib/api-client/types/audit.types";

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return <DetailField label={label}>Not available</DetailField>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function AuditDetailDialog({ entry, onOpenChange }: { entry: AuditEntry | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {entry ? (
          <>
            <DialogHeader>
              <DialogTitle>{entry.title ?? "Audit event"}</DialogTitle>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <ActivityTypeBadge type={entry.type} />
                <AuditSourceBadge source={entry.source} />
              </div>
            </DialogHeader>
            <div className="space-y-4">
              <DetailGrid>
                <DetailField label="Time">{formatDateTime(entry.occurredAt)}</DetailField>
                <DetailField label="Actor">
                  {entry.actor ? `${entry.actor.name}${entry.actorRole ? ` (${entry.actorRole})` : ""}` : "System / integration"}
                </DetailField>
                <DetailField label="Entity">{entry.entityType ? `${entry.entityType}` : "—"}</DetailField>
                <DetailField label="Customer">
                  {entry.customer ? (
                    <Link href={customerDetailHref(entry.customer.leadId)} className="text-primary hover:underline">
                      {entry.customer.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </DetailField>
                <DetailField label="Order">
                  {entry.order ? (
                    <Link href={orderDetailHref(entry.order.id)} className="text-primary hover:underline">
                      {entry.order.orderNumber}
                    </Link>
                  ) : (
                    "—"
                  )}
                </DetailField>
              </DetailGrid>
              {entry.description ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Description</p>
                  <p className="text-sm">{entry.description}</p>
                </div>
              ) : null}
              <JsonBlock label="Old value" value={entry.oldValue} />
              <JsonBlock label="New value" value={entry.newValue} />
              <JsonBlock label="Metadata" value={entry.metadata} />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
