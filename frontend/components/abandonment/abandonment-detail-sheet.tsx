"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { customerDetailHref } from "@/components/orders/orders-table";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentDetailQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { AbandonmentStatusBadge, RECOVERY_ACTION_TYPE_LABELS } from "./abandonment-status-badge";
import { LogRecoveryActionDialog } from "./log-recovery-action-dialog";
import type { ReactNode } from "react";

const NOT_AVAILABLE = "Not available";

// "PAYMENT_INITIATED" -> "Payment initiated" - the raw checkout-stage code Shiprocket Checkout
// reports, made readable without inventing a fixed label set for values that are not documented.
function humanizeStage(stage: string): string {
  return stage
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading abandonment">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

export function AbandonmentDetailSheet({ abandonmentId, onOpenChange }: { abandonmentId: string | null; onOpenChange: (id: string | null) => void }) {
  const [logOpen, setLogOpen] = useState(false);
  const { data: abandonment, isLoading, error, refetch } = useQuery({
    ...abandonmentDetailQueryOptions(abandonmentId ?? ""),
    enabled: abandonmentId !== null,
  });

  return (
    <Sheet open={abandonmentId !== null} onOpenChange={(open) => !open && onOpenChange(null)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Abandoned checkout</SheetTitle>
          <SheetDescription>{abandonment ? abandonment.lead.name : "Loading…"}</SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-4">
          {isLoading ? (
            <DetailSkeleton />
          ) : error || !abandonment ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {getErrorMessage(error, "This abandonment could not be found.")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <AbandonmentStatusBadge status={abandonment.status} />
                {abandonment.priorityReason ? <span className="text-xs text-muted-foreground">{abandonment.priorityReason}</span> : null}
              </div>

              <Section title="Customer">
                <DetailGrid>
                  <DetailField label="Name">
                    <Link href={customerDetailHref(abandonment.lead.id)} className="text-primary hover:underline">
                      {abandonment.lead.name}
                    </Link>
                  </DetailField>
                  <DetailField label="Lead number">{abandonment.lead.leadNumber}</DetailField>
                  <DetailField label="Mobile">{abandonment.lead.mobile ?? NOT_AVAILABLE}</DetailField>
                  {abandonment.lead.email ? <DetailField label="Email">{abandonment.lead.email}</DetailField> : null}
                </DetailGrid>
              </Section>

              <Separator />

              <Section title="Cart">
                {abandonment.cartSnapshot ? (
                  <>
                    <DetailGrid>
                      <DetailField label="Cart value">
                        {abandonment.cartSnapshot.cartValue ? formatMoney(abandonment.cartSnapshot.cartValue, abandonment.cartSnapshot.currency ?? "INR") : NOT_AVAILABLE}
                      </DetailField>
                      {abandonment.cartSnapshot.stage ? (
                        <DetailField label="Checkout stage">
                          <Badge variant="outline">{humanizeStage(abandonment.cartSnapshot.stage)}</Badge>
                        </DetailField>
                      ) : null}
                    </DetailGrid>
                    {abandonment.cartSnapshot.itemNames.length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Items</p>
                        <ul className="list-inside list-disc space-y-0.5 text-sm">
                          {abandonment.cartSnapshot.itemNames.map((name, i) => (
                            <li key={i}>{name}</li>
                          ))}
                          {(abandonment.cartSnapshot.itemCount ?? 0) > abandonment.cartSnapshot.itemNames.length ? (
                            <li className="text-muted-foreground">
                              +{(abandonment.cartSnapshot.itemCount ?? 0) - abandonment.cartSnapshot.itemNames.length} more
                            </li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                    {abandonment.cartSnapshot.checkoutUrl ? (
                      <Button
                        variant="outline"
                        size="sm"
                        render={<a href={abandonment.cartSnapshot.checkoutUrl} target="_blank" rel="noreferrer" />}
                      >
                        <ExternalLink data-icon="inline-start" />
                        Open resume-checkout link
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{abandonment.summary ?? "No further cart details were reported."}</p>
                )}
                <DetailGrid>
                  <DetailField label="Detected">{formatDateTime(abandonment.detectedAt)}</DetailField>
                  <DetailField label="Source">{abandonment.source?.name ?? NOT_AVAILABLE}</DetailField>
                  {abandonment.recoveredAt ? <DetailField label="Recovered">{formatDateTime(abandonment.recoveredAt)}</DetailField> : null}
                </DetailGrid>
              </Section>

              <Separator />

              <Section title="Recovery history">
                {abandonment.recoveryActions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No recovery actions logged yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {abandonment.recoveryActions.map((action) => (
                      <li key={action.id} className="rounded-lg border border-ink-line/25 p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{RECOVERY_ACTION_TYPE_LABELS[action.type]}</span>
                          <span className="text-xs text-muted-foreground">{formatDateTime(action.createdAt)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {action.status} {action.performedBy ? `· by ${action.performedBy.name}` : ""}
                        </div>
                        {action.notes ? <p className="mt-1 text-sm">{action.notes}</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <Button size="sm" onClick={() => setLogOpen(true)} disabled={abandonment.status === "RECOVERED"}>
                  Log recovery action
                </Button>
              </Section>
            </>
          )}
        </div>
      </SheetContent>

      {abandonment ? (
        <LogRecoveryActionDialog
          abandonmentId={abandonment.id}
          open={logOpen}
          onOpenChange={setLogOpen}
          onDone={() => {
            setLogOpen(false);
            refetch();
          }}
        />
      ) : null}
    </Sheet>
  );
}
