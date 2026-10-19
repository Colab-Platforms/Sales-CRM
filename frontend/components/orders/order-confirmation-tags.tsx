"use client";

import { Tag, UserCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { useRetryConfirmationTagSyncMutation } from "@/lib/api-client/mutations/orders.mutations";
import { formatDateTime } from "@/lib/order-status";
import type { OrderDetail } from "@/lib/api-client/types/orders.types";

type Props = Pick<OrderDetail, "id" | "confirmedBy" | "confirmationTag" | "shopifyConfirmationTag" | "confirmedAt" | "externalNumber"> & Partial<Pick<OrderDetail, "createdByUser" | "creatorTag" | "shopifyCreatorTag">>;

// "Tags" for an order, plus who confirmed it and when. The tag text always comes from the backend (derived from the structured confirmer),
// never built from anything typed in the browser. Nothing confirmed from the CRM -> the usual empty state ("—").
export function OrderConfirmationTags({ id, confirmedBy, confirmationTag, shopifyConfirmationTag, confirmedAt, externalNumber, createdByUser, creatorTag, shopifyCreatorTag }: Props) {
  const retry = useRetryConfirmationTagSyncMutation();
  const failed = shopifyConfirmationTag?.status === "failed" || shopifyCreatorTag?.status === "failed";
  const failedReason = shopifyConfirmationTag?.status === "failed" ? shopifyConfirmationTag.reason : shopifyCreatorTag?.reason;

  return (
    <div className="grid gap-2" data-testid="order-tags">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tags</p>
      {confirmationTag || creatorTag ? (
        <div className="flex flex-wrap items-center gap-2">
          {creatorTag ? (
            <Badge variant="secondary" className="gap-1 font-medium" data-testid="creator-tag">
              <Tag className="size-3" aria-hidden />
              {creatorTag}
            </Badge>
          ) : null}
          {confirmationTag ? (
            <Badge variant="secondary" className="gap-1 font-medium">
              <Tag className="size-3" aria-hidden />
              {confirmationTag}
            </Badge>
          ) : null}
          {externalNumber && (shopifyConfirmationTag?.status === "synced" || shopifyCreatorTag?.status === "synced") ? <span className="text-xs text-muted-foreground">Also on Shopify {externalNumber}</span> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">—</p>
      )}
      {createdByUser ? (
        <dl className="grid gap-0.5 text-sm">
          <div className="flex gap-2">
            <dt className="flex items-center gap-1 text-muted-foreground"><UserPlus className="size-3.5" aria-hidden />Created by:</dt>
            <dd className="font-medium">{createdByUser.name}</dd>
          </div>
        </dl>
      ) : null}
      {confirmedBy ? (
        <dl className="grid gap-0.5 text-sm">
          <div className="flex gap-2">
            <dt className="flex items-center gap-1 text-muted-foreground"><UserCheck className="size-3.5" aria-hidden />Confirmed by:</dt>
            <dd className="font-medium">{confirmedBy.name}</dd>
          </div>
          {confirmedAt ? (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Confirmed at:</dt>
              <dd>{formatDateTime(confirmedAt)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>The Shopify tag could not be updated{failedReason ? `: ${failedReason}` : "."} The CRM order and its tags are saved.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            onClick={() =>
              retry.mutate(id, {
                onSuccess: (r) => (r.status === "failed" ? toast.error(r.reason ?? "Shopify tag sync failed.") : toast.success("Shopify tag updated.")),
                onError: (e) => toast.error(getErrorMessage(e, "Could not retry the Shopify tag sync.")),
              })
            }
          >
            {retry.isPending ? "Retrying…" : "Retry Shopify tag"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
