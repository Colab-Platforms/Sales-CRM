import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { orderDetailHref } from "@/components/orders/orders-table";
import { NbaBadge } from "./nba-badge";
import { NbaPriorityBadge } from "./nba-priority-badge";
import type { NextBestActionInfo } from "@/lib/api-client/types/customers.types";

const CHANNEL_LABELS: Record<string, string> = { CALL: "Call", EMAIL: "Email", WHATSAPP: "WhatsApp", NONE: "Not required" };

export function NextBestActionCard({ nba }: { nba: NextBestActionInfo }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Next Best Action</CardTitle>
          <NbaBadge action={nba.action} />
          <NbaPriorityBadge priority={nba.priority} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{nba.reason}</p>
        <DetailGrid>
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
