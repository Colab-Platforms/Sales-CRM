"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccentCard, SectionTitle } from "@/components/orders/order-detail-parts";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";
import { APPROVAL_DISCLAIMER, REFUND_STATUS_NOTE, canRequestRefund } from "@/lib/refund-status";
import type { OrderRefundInfo, RefundRequestView, RefundablePaymentView } from "@/lib/api-client/types/refunds.types";
import { RefundRequestDialog } from "./refund-request-dialog";
import { RefundStatusBadge } from "./refund-status-badge";

/** One request, with its status and what that status does NOT mean (approved is never "refunded"). */
export function RefundRequestRow({ request }: { request: RefundRequestView }) {
  const money = (v: string) => formatMoney(v, request.currency);
  return (
    <li className="space-y-1 rounded-lg border bg-muted/20 p-3 text-sm" data-testid="refund-request-row">
      <div className="flex flex-wrap items-center gap-2">
        <RefundStatusBadge status={request.status} />
        <span className="font-semibold tabular-nums">{money(request.amount)}</span>
        <span className="text-xs text-muted-foreground">
          requested {formatDateTime(request.createdAt)} by {request.requestedBy.name}
        </span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="refund-status-note">
        {REFUND_STATUS_NOTE[request.status]}
      </p>
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
    </li>
  );
}

/** Pure presentation of the refund section: payments (request button or why not) + the order's requests. */
export function OrderRefundSectionBody({ info, role, onRequest }: { info: OrderRefundInfo; role: string | undefined; onRequest: (payment: RefundablePaymentView) => void }) {
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
                </p>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="refund-unavailable">
                  Refund unavailable: {p.ineligibleReason}
                </p>
              )}
            </div>
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
            <RefundRequestRow key={r.id} request={r} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function OrderRefundSection({ orderId, orderNumber, info }: { orderId: string; orderNumber: string; info: OrderRefundInfo | undefined }) {
  const role = useAuthStore((s) => s.user?.role);
  const [target, setTarget] = useState<RefundablePaymentView | null>(null);
  if (!info) return null;
  return (
    <AccentCard accent="purple">
      <SectionTitle icon={<RotateCcw />} accent="purple">
        Refunds
      </SectionTitle>
      <CardContent>
        <OrderRefundSectionBody info={info} role={role} onRequest={setTarget} />
        {target ? <RefundRequestDialog open onOpenChange={(o) => !o && setTarget(null)} orderId={orderId} orderNumber={orderNumber} payment={target} /> : null}
      </CardContent>
    </AccentCard>
  );
}
