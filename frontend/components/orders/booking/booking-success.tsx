"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRefreshPaymentMutation } from "@/lib/api-client/mutations/integrations.mutations";
import type { CreateBookingResponse } from "@/lib/api-client/types/booking.types";

const inr = (value: string | number) =>
  `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const POLL_MS = 10_000;
const POLL_FOR_MS = 15 * 60_000;

/** After placing: order summary, and for payment-link orders the link plus a live "waiting for payment" check. */
export function BookingSuccess({
  placed,
  onStartAnother,
}: {
  placed: CreateBookingResponse;
  onStartAnother: () => void;
}) {
  const link = placed.paymentLink;
  const [paymentStatus, setPaymentStatus] = useState<string>(link?.status ?? "PENDING");
  const refresh = useRefreshPaymentMutation();

  const paid = paymentStatus === "SUCCESS";
  const failed = paymentStatus === "FAILED" || paymentStatus === "CANCELLED";
  const waiting = !!link?.paymentUrl && !paid && !failed;

  const checkNow = () => {
    if (!link) return;
    refresh.mutate(link.paymentId, {
      onSuccess: (result) => setPaymentStatus(String(result.status)),
    });
  };

  // Ask Cashfree every 10 seconds (for up to 15 minutes) while the customer is paying on the call.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) {
        clearInterval(timer);
        return;
      }
      checkNow();
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, link?.paymentId]);

  const copy = async () => {
    if (!link?.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(link.paymentUrl);
      toast.success("Payment link copied");
    } catch {
      toast.error("Could not copy — select the link and copy it manually");
    }
  };

  const payment = placed.order.payments[0];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Order {placed.order.orderNumber} placed</CardTitle>
          <CardDescription>
            {placed.duplicate ? "This order had already been placed — no duplicate was created." : "Saved to the CRM."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex justify-between">
            <span>Status</span>
            <Badge>{paid ? "CONFIRMED" : placed.order.status}</Badge>
          </div>
          <div className="flex justify-between">
            <span>Total</span>
            <span className="font-semibold">{inr(placed.order.totalAmount)}</span>
          </div>
          {!link && payment && (
            <div className="flex justify-between">
              <span>Payment</span>
              <span>
                {payment.method} · {payment.status}
              </span>
            </div>
          )}

          {placed.paymentLinkError && (
            <p className="text-amber-600">
              The order is saved, but the payment link could not be created: {placed.paymentLinkError}. Open the order
              to create it again.
            </p>
          )}

          {link?.paymentUrl && (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <div className="font-medium">Payment link · {inr(link.amount)} (fixed amount, any UPI app)</div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={link.paymentUrl}
                  className="h-9 w-full rounded-md border bg-muted/40 px-3 text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copy}>
                  Copy
                </Button>
                <a href={link.paymentUrl} target="_blank" rel="noopener noreferrer">
                  <Button type="button" variant="outline">
                    Open
                  </Button>
                </a>
              </div>

              {placed.whatsApp && (
                <p className={placed.whatsApp.sent ? "text-green-700" : "text-amber-600"}>
                  {placed.whatsApp.sent ? "✓ Sent to the customer on WhatsApp." : placed.whatsApp.reason}
                </p>
              )}

              {paid && <p className="font-semibold text-green-700">✓ Payment received — order confirmed.</p>}
              {failed && (
                <p className="text-red-600">
                  Payment {paymentStatus.toLowerCase()}. Open the order to create a new link.
                </p>
              )}
              {waiting && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    Waiting for payment… checking automatically every 10 seconds.
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={checkNow} disabled={refresh.isPending}>
                    {refresh.isPending ? "Checking…" : "Check now"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Link href={`/dashboard/orders/${placed.order.id}`}>
              <Button type="button">Open order</Button>
            </Link>
            <Button type="button" variant="outline" onClick={onStartAnother}>
              Start another order
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}