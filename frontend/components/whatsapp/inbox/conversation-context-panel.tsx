"use client";

import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Bot,
  ClipboardList,
  Mail,
  MessageCircle,
  Phone,
  ShoppingCart,
  User as UserIcon,
  UserX,
  Zap,
} from "lucide-react";
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
import { formatMoney, formatDateTime } from "@/lib/order-status";
import { LEAD_PRIORITY_LABELS } from "@/lib/customer-status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailField, DetailGrid } from "@/components/orders/detail-field";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomerStatusBadge } from "@/components/customers/customer-status-badge";
import { NextBestActionCard } from "@/components/customers/next-best-action-card";
import { CustomerOrdersList } from "@/components/customers/customer-orders-list";
import type { Customer360 } from "@/lib/api-client/types/customers.types";

function AiHandoffCard({ leadId }: { leadId: string }) {
  const { data, isPending, error } = useQuery(conversationDetailQueryOptions(leadId));
  const currentUser = useAuthStore((s) => s.user);
  const assign = useAssignConversationMutation();
  const handoff = useHandoffConversationMutation();
  const returnToAi = useReturnConversationToAiMutation();

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {data?.mode === "AI" ? <Bot className="size-3.5" /> : <UserIcon className="size-3.5" />}
          Conversation Mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : axios.isAxiosError(error) && error.response?.status === 404 ? (
          // Never actually an error: this customer has simply never had a WhatsApp conversation start
          // (no inbound message yet) - a normal, common state, not something to show as a failure.
          <p className="text-sm text-muted-foreground">No WhatsApp conversation yet for this customer.</p>
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
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">AI Order Draft</CardTitle>
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

function ActionsCard({
  data,
  canSendWhatsApp,
  onSendWhatsApp,
  onCreateOrder,
  isArchived,
  onDeleteChat,
  onDeleteCustomer,
}: {
  data: Customer360 | null | undefined;
  canSendWhatsApp: boolean;
  onSendWhatsApp: () => void;
  onCreateOrder: () => void;
  isArchived: boolean;
  onDeleteChat: () => void;
  onDeleteCustomer: () => void;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="size-3.5" />
          Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2">
        <Button size="sm" onClick={onSendWhatsApp} disabled={!canSendWhatsApp}>
          <MessageCircle data-icon="inline-start" />
          Send WhatsApp
        </Button>
        <Button size="sm" variant="outline" onClick={onCreateOrder} disabled={!data}>
          <ShoppingCart data-icon="inline-start" />
          Create Order
        </Button>
        <Button size="sm" variant="outline" onClick={onDeleteChat} disabled={!data}>
          {isArchived ? <ArchiveRestore data-icon="inline-start" /> : <Archive data-icon="inline-start" />}
          {isArchived ? "Restore Chat" : "Delete Chat"}
        </Button>
        <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onDeleteCustomer} disabled={!data}>
          <UserX data-icon="inline-start" />
          Delete Customer
        </Button>
      </CardContent>
    </Card>
  );
}

function CustomerCard({ customer }: { customer: Customer360 }) {
  const { profile } = customer;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <UserIcon className="size-3.5" />
          Customer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-base font-semibold">{profile.name}</p>
          <CustomerStatusBadge status={profile.workingStatus} />
          <Badge variant="outline">{LEAD_PRIORITY_LABELS[profile.priority]}</Badge>
        </div>
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-2">
            <Phone className="size-3.5 shrink-0 text-muted-foreground" />
            <span>{profile.mobile ?? "—"}</span>
          </p>
          <p className="flex items-center gap-2">
            <Mail className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{profile.email ?? "—"}</span>
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Lead #{profile.leadNumber}</p>
      </CardContent>
    </Card>
  );
}

function CustomerDetailsCard({ customer }: { customer: Customer360 }) {
  const { profile } = customer;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ClipboardList className="size-3.5" />
          Customer Details
        </CardTitle>
      </CardHeader>
      <CardContent>
        <DetailGrid compact>
          <DetailField label="Source">{profile.source?.name ?? "—"}</DetailField>
          <DetailField label="Assigned salesperson">{profile.owner?.name ?? "—"}</DetailField>
          <DetailField label="Last activity">{formatDateTime(profile.lastActivityAt)}</DetailField>
          <DetailField label="Last contacted">{formatDateTime(profile.lastContactedAt)}</DetailField>
          <DetailField label="Customer since">{formatDateTime(profile.createdAt)}</DetailField>
        </DetailGrid>
      </CardContent>
    </Card>
  );
}

export function ConversationContextPanel({
  leadId,
  canSendWhatsApp,
  onSendWhatsApp,
  onCreateOrder,
  isArchived,
  onDeleteChat,
  onDeleteCustomer,
}: {
  leadId: string;
  canSendWhatsApp: boolean;
  onSendWhatsApp: () => void;
  onCreateOrder: () => void;
  isArchived: boolean;
  onDeleteChat: () => void;
  onDeleteCustomer: () => void;
}) {
  const { data, isLoading, error } = useCustomer360(leadId);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/* Required hierarchy: CUSTOMER, ACTIONS, CUSTOMER DETAILS, NEXT BEST ACTION, ORDERS. AI
          handoff/order-draft (a separate, existing automation feature, not part of this hierarchy)
          are kept below it rather than removed. */}
      {isLoading ? (
        <>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-28 w-full" />
        </>
      ) : error || !data ? (
        <p className="text-sm text-destructive">{error ?? "Could not load customer."}</p>
      ) : (
        <>
          <CustomerCard customer={data} />
          <ActionsCard
            data={data}
            canSendWhatsApp={canSendWhatsApp}
            onSendWhatsApp={onSendWhatsApp}
            onCreateOrder={onCreateOrder}
            isArchived={isArchived}
            onDeleteChat={onDeleteChat}
            onDeleteCustomer={onDeleteCustomer}
          />
          <CustomerDetailsCard customer={data} />
          <NextBestActionCard nba={data.nextBestAction} compact />
          <CustomerOrdersList orders={data.orders} compact />
        </>
      )}
      <AiHandoffCard leadId={leadId} />
      <OrderDraftCard leadId={leadId} />
    </div>
  );
}
