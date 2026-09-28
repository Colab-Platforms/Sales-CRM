"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, CreditCard, Package, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { RECOVERY_ACTION_TYPE_LABELS } from "./abandonment-status-badge";
import { LogRecoveryActionDialog } from "./log-recovery-action-dialog";
import { parseAbandonmentCart, humanizeStage } from "./abandonment-cart-utils";
import type { AbandonmentDetail } from "@/lib/api-client/types/abandonment.types";

const NOT_AVAILABLE = "Not available";
const INITIAL_VISIBLE_COUNT = 3;

// Same cart-details/recovery-history content the abandoned-leads queue used to show in a side sheet,
// now embedded directly on the lead's own detail page (same page normal leads open) so a salesperson
// works an abandoned lead the same way as any other lead, with this panel as the extra context.
export function AbandonmentPanel({ abandonment }: { abandonment: AbandonmentDetail }) {
  const [logOpen, setLogOpen] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);

  const cart = useMemo(() => parseAbandonmentCart(abandonment), [abandonment]);

  const allDisplayItems = useMemo(() => {
    const items: { name: string; isCaptured: boolean }[] = cart.itemNames.map((name) => ({ name, isCaptured: true }));
    const totalCount = Math.max(cart.itemCount ?? 0, items.length);
    const missing = totalCount - items.length;
    for (let i = 0; i < missing; i++) {
      items.push({ name: `Cart item #${items.length + 1}`, isCaptured: false });
    }
    return items;
  }, [cart]);

  const visibleItems = showAllItems ? allDisplayItems : allDisplayItems.slice(0, INITIAL_VISIBLE_COUNT);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {cart.stage ? (
          <Badge variant="outline" className="gap-1 bg-background font-medium">
            <CreditCard className="size-3 text-muted-foreground" />
            {humanizeStage(cart.stage)}
          </Badge>
        ) : null}
        {abandonment.priorityReason ? <span className="text-xs text-muted-foreground">{abandonment.priorityReason}</span> : null}
      </div>

      <div className="space-y-3 rounded-xl border-[1.5px] border-ink-line/20 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cart Value</p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {cart.cartValue ? formatMoney(cart.cartValue, cart.currency) : NOT_AVAILABLE}
            </p>
          </div>
          {allDisplayItems.length > 0 ? (
            <Badge variant="secondary" className="px-2.5 py-1 text-xs font-semibold">
              <ShoppingCart className="mr-1 size-3.5" />
              {allDisplayItems.length} {allDisplayItems.length === 1 ? "Item" : "Items"}
            </Badge>
          ) : null}
        </div>
      </div>

      {allDisplayItems.length > 0 ? (
        <div className="space-y-2">
          {visibleItems.map((item, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-3 shadow-2xs">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Package className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-semibold leading-snug text-foreground">{item.name}</p>
                {!item.isCaptured ? <p className="text-xs text-muted-foreground">Additional checkout item</p> : null}
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px] font-mono text-muted-foreground">
                #{i + 1}
              </Badge>
            </div>
          ))}

          {allDisplayItems.length > INITIAL_VISIBLE_COUNT ? (
            showAllItems ? (
              <Button type="button" variant="ghost" size="sm" className="w-full gap-1.5 text-muted-foreground hover:text-foreground" onClick={() => setShowAllItems(false)}>
                <ChevronUp className="size-4" />
                Show fewer items
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" className="w-full gap-1.5 font-medium" onClick={() => setShowAllItems(true)}>
                <ChevronDown className="size-4" />
                View all {allDisplayItems.length} items
              </Button>
            )
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{abandonment.summary ?? "No further cart details were reported."}</p>
      )}

      <DetailGrid compact>
        <DetailField label="Detected">{formatDateTime(abandonment.detectedAt)}</DetailField>
        <DetailField label="Source">{abandonment.source?.name ?? NOT_AVAILABLE}</DetailField>
        {abandonment.recoveredAt ? <DetailField label="Recovered">{formatDateTime(abandonment.recoveredAt)}</DetailField> : null}
      </DetailGrid>

      <div className="space-y-3 border-t border-border/60 pt-3">
        <h4 className="text-sm font-semibold">Recovery History</h4>
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
      </div>

      <LogRecoveryActionDialog abandonmentId={abandonment.id} open={logOpen} onOpenChange={setLogOpen} onDone={() => setLogOpen(false)} />
    </div>
  );
}
