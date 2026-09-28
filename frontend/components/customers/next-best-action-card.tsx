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
    <Card size={compact ? "sm" : "default"}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className={compact ? "flex items-center gap-2 text-sm" : "flex items-center gap-2"}>
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
