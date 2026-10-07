"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useApproveRefundMutation, useRejectRefundMutation } from "@/lib/api-client/mutations/refunds.mutations";
import { refundQueueQueryOptions } from "@/lib/api-client/queries/refunds.queries";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { APPROVAL_DISCLAIMER, REFUND_STATUS_NOTE, canDecide, isApprover } from "@/lib/refund-status";
import { useAuthStore } from "@/stores/auth-store";
import type { RefundRequestStatus, RefundRequestView } from "@/lib/api-client/types/refunds.types";
import { RefundStatusBadge } from "./refund-status-badge";

type Filter = RefundRequestStatus | "ALL";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ALL", label: "All" },
];

/** The queue table. Approve / Reject appear only for a MANAGER/ADMIN on a PENDING request they did not raise themselves. */
export function RefundQueueTable({
  items,
  role,
  userId,
  busyId,
  onApprove,
  onReject,
}: {
  items: RefundRequestView[];
  role: string | undefined;
  userId: string | undefined;
  busyId?: string | null;
  onApprove: (r: RefundRequestView) => void;
  onReject: (r: RefundRequestView) => void;
}) {
  if (items.length === 0) return <p className="p-6 text-center text-sm text-muted-foreground">No refund requests here.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="refund-queue">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Order</th>
            <th className="px-3 py-2 font-medium">Customer</th>
            <th className="px-3 py-2 font-medium">Requested by</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
            <th className="px-3 py-2 font-medium">Payment</th>
            <th className="px-3 py-2 font-medium">Reason</th>
            <th className="px-3 py-2 font-medium">Requested</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const money = (v: string) => formatMoney(v, r.currency);
            const own = r.requestedBy.id === userId;
            return (
              <tr key={r.id} className="border-b align-top" data-testid="refund-queue-row">
                <td className="px-3 py-2">
                  <Link href={`/dashboard/orders/${r.orderId}`} className="font-medium text-primary hover:underline">
                    {r.orderNumber}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {r.customer.name}
                  {r.customer.mobile ? <span className="block text-xs text-muted-foreground">{r.customer.mobile}</span> : null}
                </td>
                <td className="px-3 py-2">
                  {r.requestedBy.name}
                  <span className="block text-xs text-muted-foreground">{r.requestedBy.role}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className="font-semibold">{money(r.amount)}</span>
                  <span className="block text-xs text-muted-foreground">of {money(r.paymentAmount)} paid</span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.paymentMethod ?? "—"}
                  <span className="block">already refunded {money(r.refundedAmount)}</span>
                  <span className="block">remaining refundable {money(r.remainingRefundableAmount)}</span>
                </td>
                <td className="max-w-[18rem] px-3 py-2 break-words">
                  {r.reason}
                  {r.decisionNote ? <span className="mt-1 block text-xs text-muted-foreground">Decision note: {r.decisionNote}</span> : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</td>
                <td className="px-3 py-2">
                  <RefundStatusBadge status={r.status} />
                  <span className="mt-1 block text-xs text-muted-foreground">{REFUND_STATUS_NOTE[r.status]}</span>
                </td>
                <td className="px-3 py-2">
                  {canDecide(role, userId, r) ? (
                    <div className="flex gap-2">
                      <Button type="button" size="sm" disabled={busyId === r.id} onClick={() => onApprove(r)}>
                        Approve
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={busyId === r.id} onClick={() => onReject(r)}>
                        Reject
                      </Button>
                    </div>
                  ) : r.status === "PENDING" && own ? (
                    <span className="text-xs text-muted-foreground" data-testid="own-request-note">
                      Your request — another approver decides it
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ApproveRefundDialog({ request, busy, onConfirm, onClose }: { request: RefundRequestView; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Approve refund request?</DialogTitle>
          <DialogDescription>
            {formatMoney(request.amount, request.currency)} for order {request.orderNumber}. {APPROVAL_DISCLAIMER}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Approving does not refund the customer now and does not change the order or payment.</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Approving…" : "Confirm approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RejectRefundDialog({ request, busy, onConfirm, onClose }: { request: RefundRequestView; busy: boolean; onConfirm: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = note.trim() === "";
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Reject refund request</DialogTitle>
          <DialogDescription>
            {formatMoney(request.amount, request.currency)} for order {request.orderNumber}. The requester will see your reason.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <label htmlFor="reject-note" className="text-sm font-medium">
            Rejection reason
          </label>
          <textarea
            id="reject-note"
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-invalid={touched && missing}
          />
          {touched && missing ? (
            <p role="alert" className="text-xs text-destructive">
              A rejection reason is required.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setTouched(true);
              if (!missing) onConfirm(note.trim());
            }}
          >
            {busy ? "Rejecting…" : "Reject request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RefundQueueView() {
  const user = useAuthStore((s) => s.user);
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [approving, setApproving] = useState<RefundRequestView | null>(null);
  const [rejecting, setRejecting] = useState<RefundRequestView | null>(null);
  const queue = useQuery({ ...refundQueueQueryOptions({ status: filter, page: 1, pageSize: 50 }), enabled: isApprover(user?.role) });
  const approve = useApproveRefundMutation();
  const reject = useRejectRefundMutation();
  const busy = approve.isPending || reject.isPending;

  if (user && !isApprover(user.role)) return <p className="text-sm text-muted-foreground">Only managers and admins can review refund requests.</p>;

  return (
    <div className="space-y-6">
      <PageHeader title="Refund Approvals" description={`Review refund requests raised by the team. ${APPROVAL_DISCLAIMER}`} />
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Status">
        {FILTERS.map((f) => (
          <Button key={f.value} type="button" size="sm" variant={filter === f.value ? "default" : "outline"} role="tab" aria-selected={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.label}
          </Button>
        ))}
      </div>
      {queue.error ? (
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(queue.error, "Could not load refund requests.")}
        </p>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {queue.isPending ? (
            <p className="p-4 text-sm text-muted-foreground">Loading refund requests…</p>
          ) : (
            <RefundQueueTable items={queue.data?.items ?? []} role={user?.role} userId={user?.id} busyId={busy ? (approving ?? rejecting)?.id : null} onApprove={setApproving} onReject={setRejecting} />
          )}
        </CardContent>
      </Card>
      {approving ? (
        <ApproveRefundDialog
          request={approving}
          busy={approve.isPending}
          onClose={() => setApproving(null)}
          onConfirm={() =>
            approve.mutate(
              { id: approving.id },
              {
                onSuccess: () => {
                  toast.success("Approved. The refund has not been issued yet.");
                  setApproving(null);
                },
                onError: (e) => {
                  toast.error(getErrorMessage(e, "Could not approve the request."));
                  setApproving(null);
                },
              },
            )
          }
        />
      ) : null}
      {rejecting ? (
        <RejectRefundDialog
          request={rejecting}
          busy={reject.isPending}
          onClose={() => setRejecting(null)}
          onConfirm={(note) =>
            reject.mutate(
              { id: rejecting.id, note },
              {
                onSuccess: () => {
                  toast.success("Refund request rejected.");
                  setRejecting(null);
                },
                onError: (e) => {
                  toast.error(getErrorMessage(e, "Could not reject the request."));
                  setRejecting(null);
                },
              },
            )
          }
        />
      ) : null}
    </div>
  );
}
