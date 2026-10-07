"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccentCard, SectionTitle } from "@/components/orders/order-detail-parts";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";
import { APPROVAL_DISCLAIMER, canExecute, canRefreshExecution, canRequestRefund, isApprover, refundDisplay } from "@/lib/refund-status";
import { useQuery } from "@tanstack/react-query";
import { integrationStatusQueryOptions } from "@/lib/api-client/queries/integrations.queries";
import type { OrderRefundInfo, RefundRequestView, RefundablePaymentView } from "@/lib/api-client/types/refunds.types";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/api-client/client";
import { useExecuteRefundMutation, useRefreshRefundExecutionMutation, useResolveCashfreeMutation } from "@/lib/api-client/mutations/refunds.mutations";
import { RefundRequestDialog } from "./refund-request-dialog";
import { RefundStatusBadge } from "./refund-status-badge";
import { ExecuteRefundDialog } from "./refund-queue-view";

/** What the signed-in person may do to a request from the order page (the server enforces every one of these again). */
export interface RefundRowActions {
  role?: string;
  userId?: string;
  /** The request an action is currently running for: its buttons are disabled so nothing is submitted twice. */
  busyId?: string | null;
  /** When each request's status was last checked with Cashfree from this page (ISO), by request id. */
  checkedAt?: Record<string, string>;
  onExecute?: (request: RefundRequestView) => void;
  onRefreshExecution?: (request: RefundRequestView) => void;
}

/** One refund (an order can have several): its status, the Cashfree reference and times once it has been sent, a failure's real reason, and the actions that apply. */
export function RefundRequestRow({ request, actions }: { request: RefundRequestView; actions?: RefundRowActions }) {
  const money = (v: string) => formatMoney(v, request.currency);
  const started = Boolean(request.executionStatus) || Boolean(request.refundId);
  const failed = request.status === "APPROVED" && request.executionStatus === "FAILED";
  const checked = actions?.checkedAt?.[request.id];
  const busy = actions?.busyId === request.id;
  const showExecute = canExecute(actions?.role, actions?.userId, request) && actions?.onExecute;
  const showCheck = canRefreshExecution(actions?.role, request) && actions?.onRefreshExecution;
  return (
    <li className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm" data-testid="refund-request-row">
      <div className="flex flex-wrap items-center gap-2">
        <RefundStatusBadge status={request.status} executionStatus={request.executionStatus} />
        <span className="font-semibold tabular-nums">{money(request.amount)}</span>
        <span className="text-xs text-muted-foreground">
          requested {formatDateTime(request.createdAt)} by {request.requestedBy.name}
        </span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="refund-status-note">
        {refundDisplay(request).note}
      </p>
      {request.status === "PENDING" && request.orderStatus && request.orderStatus !== "CANCELLED" ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs" data-testid="refund-approval-cancels-note">
          The order is NOT cancelled yet. When a manager approves this refund, the order is cancelled automatically.
        </p>
      ) : null}
      {request.status === "APPROVED" && !started && request.orderStatus && request.orderStatus !== "CANCELLED" ? (
        <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs" data-testid="refund-order-not-cancelled">
          This refund was approved but its order is not cancelled, so it can not be executed. Cancel the order first.
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-700 dark:text-rose-400" data-testid="refund-failure">
          Refund failed{request.failureReason ? `: ${request.failureReason}` : "."} No money was returned and the order is not marked as refunded.
        </p>
      ) : null}
      <p>
        <span className="text-muted-foreground">Reason: </span>
        {request.reason}
      </p>
      {request.decidedBy ? (
        <p className="text-xs text-muted-foreground">
          {request.status === "APPROVED" ? "Approved" : "Rejected"} by {request.decidedBy.name}
          {request.decisionAt ? ` on ${formatDateTime(request.decisionAt)}` : ""}
          {request.decisionNote ? ` — “${request.decisionNote}”` : ""}
        </p>
      ) : null}
      {
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-md bg-muted/40 p-2 text-xs" data-testid="refund-details">
          <dt className="text-muted-foreground">Order</dt>
          <dd data-testid="refund-order-state">{request.orderStatus ? (request.orderStatus === "CANCELLED" ? "Cancelled" : "Not cancelled") : "—"}</dd>
          {request.refundId ? (
            <>
              <dt className="text-muted-foreground">Refund ID</dt>
              <dd className="break-all font-mono">{request.refundId}</dd>
            </>
          ) : null}
          {request.cfRefundId ? (
            <>
              <dt className="text-muted-foreground">Cashfree reference</dt>
              <dd className="break-all font-mono">{request.cfRefundId}</dd>
            </>
          ) : null}
          {request.providerStatus ? (
            <>
              <dt className="text-muted-foreground">Cashfree status</dt>
              <dd>{request.providerStatus}</dd>
            </>
          ) : null}
          {request.executionStartedAt ? (
            <>
              <dt className="text-muted-foreground">Sent to Cashfree</dt>
              <dd>{formatDateTime(request.executionStartedAt)}</dd>
            </>
          ) : null}
          {request.executionCompletedAt ? (
            <>
              <dt className="text-muted-foreground">Completed</dt>
              <dd>{formatDateTime(request.executionCompletedAt)}</dd>
            </>
          ) : null}
          {request.executedBy ? (
            <>
              <dt className="text-muted-foreground">Sent by</dt>
              <dd>{request.executedBy.name}</dd>
            </>
          ) : null}
          {checked ? (
            <>
              <dt className="text-muted-foreground">Last checked</dt>
              <dd data-testid="refund-last-checked">{formatDateTime(checked)}</dd>
            </>
          ) : null}
        </dl>
      }
      {showExecute || showCheck ? (
        <div className="flex flex-wrap gap-2">
          {showExecute ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => actions!.onExecute!(request)} data-testid="refund-execute-button">
              {request.executionStatus === "FAILED" ? "Retry Refund" : "Execute Refund"}
            </Button>
          ) : null}
          {showCheck ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => actions!.onRefreshExecution!(request)} data-testid="refund-check-status-button">
              {busy ? "Checking…" : "Check refund status"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Pure presentation of the refund section: payments (request button or why not) + the order's requests. */
export function OrderRefundSectionBody({ info, role, onRequest, onResolve, resolvingId, rowActions }: { info: OrderRefundInfo; role: string | undefined; onRequest: (payment: RefundablePaymentView) => void; onResolve?: (payment: RefundablePaymentView) => void; resolvingId?: string | null; rowActions?: RefundRowActions }) {
  const allowed = canRequestRefund(role);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{APPROVAL_DISCLAIMER}</p>
      {info.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payment has been recorded for this order, so there is nothing to refund.</p> : null}
      {info.payments.map((p) => {
        const money = (v: string) => formatMoney(v, p.currency);
        return (
          <div key={p.paymentId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/10 p-3 text-sm" data-testid="refund-payment">
            <div>
              <p className="font-medium">
                Payment {money(p.amount)} <span className="text-xs font-normal text-muted-foreground">({p.method ?? "method unknown"})</span>
              </p>
              {p.eligible ? (
                <p className="text-xs text-muted-foreground">
                  Refundable now: {money(p.refundableAmount)}
                  {Number(p.refundedAmount) > 0 ? ` · already refunded ${money(p.refundedAmount)}` : ""}
                  {p.limitedByShopify ? " · limited to what Shopify reports as refundable" : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="refund-unavailable">
                  Refund unavailable: {p.ineligibleReason}
                </p>
              )}
            </div>
            {!p.eligible && p.canResolve && allowed && onResolve ? (
              <Button type="button" size="sm" variant="outline" disabled={resolvingId === p.paymentId} onClick={() => onResolve(p)}>
                {resolvingId === p.paymentId ? "Verifying…" : "Retry Cashfree verification"}
              </Button>
            ) : null}
            {p.eligible && allowed ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onRequest(p)}>
                Request Refund
              </Button>
            ) : null}
          </div>
        );
      })}
      {info.requests.length > 0 ? (
        <ul className="space-y-2" aria-label="Refund requests">
          {info.requests.map((r) => (
            <RefundRequestRow key={r.id} request={r} actions={rowActions} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * What the order page's top-right action area offers, decided purely from the backend's per-payment eligibility (the same rule the Refunds section uses):
 *  - "refund": a payment that can be refunded now (prepaid Cashfree, paid, Cashfree payment verified - for a Shopify order automatically after the sync - and a
 *    balance left within Shopify's refundable amount)
 *  - nothing otherwise: COD, unpaid/failed, non-Cashfree, fully refunded, not (yet) verified, Shopify says nothing is refundable, or a role that cannot request
 *    refunds. The Refunds section below explains why (and offers the optional retry of the Cashfree verification); there is no manual lookup step in the header.
 */
export type RefundHeaderAction = { kind: "refund"; payment: RefundablePaymentView } | { kind: "status"; payment: RefundablePaymentView; label: string };

export function refundHeaderActions(info: OrderRefundInfo | undefined, role: string | undefined): RefundHeaderAction[] {
  if (!info || !canRequestRefund(role)) return [];
  const refundable = info.payments.filter((p) => p.eligible).map((payment): RefundHeaderAction => ({ kind: "refund", payment }));
  if (refundable.length > 0) return refundable;
  // Everything refundable is already held by open requests: show where the refund stands instead of a second Refund button.
  const open = info.requests.find((r) => r.status === "PENDING") ?? info.requests.find((r) => r.status === "APPROVED" && r.executionStatus !== "COMPLETED");
  const held = info.payments.find((p) => !p.eligible && Number(p.reservedAmount) > 0);
  if (!open || !held) return [];
  const label = open.status === "PENDING" ? "Refund: Pending approval" : open.executionStatus === "PROCESSING" ? "Refund: Processing" : open.executionStatus === "FAILED" ? "Refund: Failed" : "Refund: Approved";
  return [{ kind: "status", payment: held, label }];
}

/** Pure presentation of the header button(s): "Refund", rendered right beside Cancel Order. */
export function RefundHeaderButtons({ actions, onRefund }: { actions: RefundHeaderAction[]; onRefund: (payment: RefundablePaymentView) => void }) {
  return (
    <>
      {actions.map((a) =>
        a.kind === "status" ? (
          <Button key={`status-${a.payment.paymentId}`} type="button" variant="outline" size="sm" disabled data-testid="header-refund-status">
            <RotateCcw data-icon="inline-start" />
            {a.label}
          </Button>
        ) : (
          <Button key={a.payment.paymentId} type="button" variant="outline" size="sm" data-testid="header-refund-button" onClick={() => onRefund(a.payment)}>
            <RotateCcw data-icon="inline-start" />
            {actions.length > 1 ? `Refund ${formatMoney(a.payment.refundableAmount, a.payment.currency)}` : "Refund"}
          </Button>
        ),
      )}
    </>
  );
}

function useCashfreeLookup(orderId: string) {
  const resolve = useResolveCashfreeMutation();
  return {
    resolvingId: resolve.isPending ? resolve.variables?.paymentId : null,
    lookup: (p: RefundablePaymentView) =>
      resolve.mutate(
        { orderId, paymentId: p.paymentId },
        {
          onSuccess: (r) => (r.resolved ? toast.success("Cashfree payment verified. A refund can now be requested.") : toast.error(`Could not verify the Cashfree payment: ${r.reason ?? "unknown reason"}.`)),
          onError: (e) => toast.error(getErrorMessage(e, "Could not verify the Cashfree payment.")),
        },
      ),
  };
}

/** The Refund action in Order Details' top-right action area (next to Cancel Order). Opens the existing refund REQUEST dialog - nothing is refunded here. */
export function OrderRefundAction({ orderId, orderNumber, customerName, info }: { orderId: string; orderNumber: string; customerName?: string; info: OrderRefundInfo | undefined }) {
  const role = useAuthStore((s) => s.user?.role);
  const [target, setTarget] = useState<RefundablePaymentView | null>(null);
  const actions = refundHeaderActions(info, role);
  if (actions.length === 0) return null;
  return (
    <>
      <RefundHeaderButtons actions={actions} onRefund={setTarget} />
      {target ? <RefundRequestDialog open onOpenChange={(o) => !o && setTarget(null)} orderId={orderId} orderNumber={orderNumber} customerName={customerName} payment={target} /> : null}
    </>
  );
}

export function OrderRefundSection({ orderId, orderNumber, customerName, info }: { orderId: string; orderNumber: string; customerName?: string; info: OrderRefundInfo | undefined }) {
  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const [target, setTarget] = useState<RefundablePaymentView | null>(null);
  const [executing, setExecuting] = useState<RefundRequestView | null>(null);
  const [checkedAt, setCheckedAt] = useState<Record<string, string>>({});
  const { lookup, resolvingId } = useCashfreeLookup(orderId);
  const execute = useExecuteRefundMutation();
  const refreshExecution = useRefreshRefundExecutionMutation();
  const integration = useQuery({ ...integrationStatusQueryOptions(), enabled: isApprover(role) });
  if (!info) return null;

  const busyId = execute.isPending ? execute.variables?.id : refreshExecution.isPending ? refreshExecution.variables?.id : null;
  const rowActions: RefundRowActions = {
    role,
    userId: user?.id,
    busyId,
    checkedAt,
    onExecute: setExecuting,
    // Asks Cashfree for the CURRENT state of the refund (not the answer received when it was sent) and shows it.
    onRefreshExecution: (r) =>
      refreshExecution.mutate(
        { id: r.id },
        {
          onSuccess: (x) => {
            setCheckedAt((c) => ({ ...c, [r.id]: new Date().toISOString() }));
            if (x.executionStatus === "COMPLETED") toast.success("Cashfree confirmed the refund.");
            else if (x.executionStatus === "FAILED") toast.error(x.failureReason ? `Cashfree did not complete the refund: ${x.failureReason}` : "Cashfree did not complete the refund.");
            else toast.info("Still pending at Cashfree. Check again in a little while.");
          },
          onError: (e) => toast.error(getErrorMessage(e, "Could not check the refund status.")),
        },
      ),
  };
  return (
    <AccentCard accent="purple">
      <SectionTitle icon={<RotateCcw />} accent="purple">
        Refunds
      </SectionTitle>
      <CardContent>
        <OrderRefundSectionBody info={info} role={role} onRequest={setTarget} resolvingId={resolvingId} onResolve={lookup} rowActions={rowActions} />
        {target ? <RefundRequestDialog open onOpenChange={(o) => !o && setTarget(null)} orderId={orderId} orderNumber={orderNumber} customerName={customerName} payment={target} /> : null}
        {executing ? (
          <ExecuteRefundDialog
            request={executing}
            environment={integration.data?.cashfree.environment}
            busy={execute.isPending}
            onClose={() => setExecuting(null)}
            onConfirm={() =>
              execute.mutate(
                { id: executing.id },
                {
                  onSuccess: (x) => {
                    if (x.executionStatus === "FAILED") toast.error(x.failureReason ? `Cashfree did not accept the refund: ${x.failureReason}` : "Cashfree did not accept the refund.");
                    else toast.success("Refund sent to Cashfree. It is shown as processing until Cashfree confirms it.");
                    setExecuting(null);
                  },
                  onError: (e) => {
                    toast.error(getErrorMessage(e, "Could not execute the refund."));
                    setExecuting(null);
                  },
                },
              )
            }
          />
        ) : null}
      </CardContent>
    </AccentCard>
  );
}
