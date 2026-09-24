"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, User as UserIcon } from "lucide-react";
import { useCustomer360 } from "@/hooks/useCustomers";
import { useAuthStore } from "@/stores/auth-store";
import { conversationDetailQueryOptions, orderDraftQueryOptions } from "@/lib/api-client/queries/whatsapp-conversation.queries";
import {
  useAssignConversationMutation,
  useConfirmOrderDraftMutation,
  useHandoffConversationMutation,
  useReturnConversationToAiMutation,
} from "@/lib/api-client/mutations/whatsapp-conversation.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { formatMoney } from "@/lib/order-status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomerProfileCard } from "@/components/customers/customer-profile-card";
import { NextBestActionCard } from "@/components/customers/next-best-action-card";
import { CustomerOrdersList } from "@/components/customers/customer-orders-list";

function AiHandoffCard({ leadId }: { leadId: string }) {
  const { data, isPending, error } = useQuery(conversationDetailQueryOptions(leadId));
  const currentUser = useAuthStore((s) => s.user);
  const assign = useAssignConversationMutation();
  const handoff = useHandoffConversationMutation();
  const returnToAi = useReturnConversationToAiMutation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {data?.mode === "AI" ? <Bot className="size-4" /> : <UserIcon className="size-4" />}
          Conversation Mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : error || !data ? (
          <p className="text-sm text-destructive">{getErrorMessage(error, "Could not load conversation.")}</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <Badge className={data.mode === "AI" ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : ""} variant={data.mode === "AI" ? "default" : "secondary"}>
                {data.mode === "AI" ? "AI is replying" : "Human handling"}
              </Badge>
              <span className="text-xs text-muted-foreground">{data.assignedTo ? `Assigned: ${data.assignedTo.name}` : "Unassigned"}</span>
            </div>

            {!data.assignedTo && currentUser ? (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={assign.isPending}
                onClick={() =>
                  assign.mutate(
                    { leadId, variables: { userId: currentUser.id } },
                    { onError: (err) => toast.error(getErrorMessage(err, "Could not assign.")) },
                  )
                }
              >
                {assign.isPending ? "Assigning..." : "Assign to me"}
              </Button>
            ) : null}

            {data.mode === "AI" ? (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={handoff.isPending}
                onClick={() => handoff.mutate({ leadId, variables: undefined }, { onSuccess: () => toast.success("Handed off to you."), onError: (err) => toast.error(getErrorMessage(err, "Could not hand off.")) })}
              >
                {handoff.isPending ? "Taking over..." : "Take over from AI"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={returnToAi.isPending || !data.assignedTo}
                title={!data.assignedTo ? "Assign this conversation to a salesperson first" : undefined}
                onClick={() => returnToAi.mutate({ leadId, variables: undefined }, { onSuccess: () => toast.success("Returned to AI."), onError: (err) => toast.error(getErrorMessage(err, "Could not enable AI mode.")) })}
              >
                {returnToAi.isPending ? "Enabling AI..." : "Return to AI"}
              </Button>
            )}

            {data.lastAiHandoffReason ? <p className="text-xs text-muted-foreground">Last AI handoff: {data.lastAiHandoffReason}</p> : null}
            {!data.aiSuggestedReply ? null : (
              <div className="sketch-outline border-violet-500/30 bg-violet-500/10 p-2.5 text-xs">
                <p className="font-medium text-violet-700 dark:text-violet-400">AI-drafted reply (this provider can&apos;t auto-send it):</p>
                <p className="mt-1">{data.aiSuggestedReply}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OrderDraftCard({ leadId }: { leadId: string }) {
  const { data, isPending } = useQuery(orderDraftQueryOptions(leadId));
  const confirm = useConfirmOrderDraftMutation();

  if (isPending) return <Skeleton className="h-32 w-full" />;
  const draft = data?.orderDraft;
  if (!draft || !draft.productId) return null;

  const quantity = draft.quantity ?? 0;
  const unitPrice = Number(draft.unitPrice ?? 0);
  const subtotal = (unitPrice * quantity).toFixed(2);
  const canConfirm = data?.orderState === "ORDER_REVIEW" || data?.orderState === "CUSTOMER_CONFIRMED";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">AI Order Draft</CardTitle>
        <CardDescription>{data?.orderState.replace(/_/g, " ")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{draft.productName ?? "—"}{draft.variantName ? ` (${draft.variantName})` : ""}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{quantity || "—"}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span>{draft.unitPrice ? formatMoney(draft.unitPrice) : "—"}</span></div>
        <div className="flex justify-between font-medium"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Payment</span><span>{draft.paymentMethod ?? "—"}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Address</span><span className="text-right">{[draft.addressLine, draft.city, draft.state, draft.pincode].filter(Boolean).join(", ") || "—"}</span></div>

        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={!canConfirm || confirm.isPending}
          onClick={() =>
            confirm.mutate(
              { leadId },
              { onSuccess: () => toast.success("Order created."), onError: (err) => toast.error(getErrorMessage(err, "Could not create the order.")) },
            )
          }
        >
          {confirm.isPending ? "Creating..." : "Confirm order"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ConversationContextPanel({ leadId }: { leadId: string }) {
  const { data, isLoading, error } = useCustomer360(leadId);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <AiHandoffCard leadId={leadId} />
      <OrderDraftCard leadId={leadId} />
      {isLoading ? (
        <>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : error || !data ? (
        <p className="text-sm text-destructive">{error ?? "Could not load customer."}</p>
      ) : (
        <>
          <CustomerProfileCard customer={data} />
          <NextBestActionCard nba={data.nextBestAction} />
          <CustomerOrdersList orders={data.orders} />
        </>
      )}
    </div>
  );
}
