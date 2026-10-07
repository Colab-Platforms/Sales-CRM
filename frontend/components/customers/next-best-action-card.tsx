import Link from "next/link";
import { Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { orderDetailHref } from "@/components/orders/orders-table";
import { NbaBadge } from "./nba-badge";
import { NbaPriorityBadge } from "./nba-priority-badge";
import type { NextBestActionInfo } from "@/lib/api-client/types/customers.types";

const CHANNEL_LABELS: Record<string, string> = { CALL: "Call", EMAIL: "Email", WHATSAPP: "WhatsApp", NONE: "Not required" };

export function NextBestActionCard({ nba, compact }: { nba: NextBestActionInfo; compact?: boolean }) {
  return (
    // shrink-0: a flex item's automatic min-size (which normally stops it shrinking below its own
    // content) is disabled whenever its overflow isn't "visible" - Card sets overflow-hidden, so
    // inside a height-bounded flex-col (the WhatsApp Inbox sidebar) this card would otherwise get
    // silently squeezed shorter than its content and have that excess invisibly clipped. shrink-0
    // forces it to always render at full natural height; the scrollable ancestor handles overflow.
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2">
            {compact ? <Target className="size-3.5" /> : null}
            Next Best Action
          </CardTitle>
          <NbaBadge action={nba.action} />
          <NbaPriorityBadge priority={nba.priority} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{nba.reason}</p>
        <DetailGrid compact={compact}>
          <DetailField label="Recommended channel">{CHANNEL_LABELS[nba.recommendedChannel]}</DetailField>
          {nba.relatedOrderId ? (
            <DetailField label="Related order">
              <Link href={orderDetailHref(nba.relatedOrderId)} className="text-primary hover:underline">
                View order
              </Link>
            </DetailField>
          ) : null}
        </DetailGrid>
      </CardContent>
    </Card>
  );
}
