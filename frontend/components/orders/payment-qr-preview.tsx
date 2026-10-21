"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { QrCode, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MediaFrame, type MediaState } from "@/components/whatsapp/conversation/message-media";
import { getErrorMessage } from "@/lib/api-client/client";
import { ordersApi } from "@/lib/api-client/endpoints/orders.api";
import { useSendPaymentQrMutation } from "@/lib/api-client/mutations/orders.mutations";
import { useAuthStore } from "@/stores/auth-store";

/** The same QR card that is sent to the customer, loaded from the CRM's own authenticated route. Viewing is display only: it creates no link and never changes the payment. */
export function qrViewState(args: { requested: boolean; isError: boolean; status?: number; hasImage: boolean }): MediaState {
  if (!args.requested) return "idle";
  if (args.isError) return args.status === 404 ? "expired" : "error";
  return args.hasImage ? "ready" : "loading";
}

export function PaymentQrPreview({ orderId, paymentId }: { orderId: string; paymentId: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const [requested, setRequested] = useState(false);
  const send = useSendPaymentQrMutation();
  const query = useQuery({
    queryKey: ["order-payment-qr", orderId, paymentId],
    queryFn: () => ordersApi.getPaymentQrImage(orderId, paymentId),
    enabled: requested,
    staleTime: 5 * 60 * 1000,
    retry: (count, error) => !(axios.isAxiosError(error) && error.response && error.response.status < 500) && count < 1,
  });
  const url = useMemo(() => (query.data ? URL.createObjectURL(query.data) : null), [query.data]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const status = axios.isAxiosError(query.error) ? query.error.response?.status : undefined;
  const state = qrViewState({ requested, isError: query.isError, status, hasImage: Boolean(url) });
  const canSend = role === "ADMIN" || role === "MANAGER" || role === "SALESPERSON";

  function handleSend() {
    send.mutate(
      { orderId, paymentId },
      {
        onSuccess: (result) => (result.status === "SENT" ? toast.success("QR code sent on WhatsApp.") : toast.error(result.reason ?? "The QR code was not sent. The payment link still works.")),
        onError: (error) => toast.error(getErrorMessage(error, "Could not send the QR code.")),
      },
    );
  }

  return (
    <div className="space-y-2" data-testid="payment-qr-preview">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setRequested((v) => !v)}>
          <QrCode data-icon="inline-start" />
          {requested ? "Hide QR" : "View QR"}
        </Button>
        {canSend ? (
          <Button type="button" size="sm" variant="outline" onClick={handleSend} disabled={send.isPending}>
            <Send data-icon="inline-start" />
            {send.isPending ? "Sending…" : "Send QR on WhatsApp"}
          </Button>
        ) : null}
      </div>
      {requested ? <MediaFrame media={{ kind: "image", mimeType: "image/png", filename: "Payment QR" }} state={state} url={url} onLoad={() => void query.refetch()} /> : null}
    </div>
  );
}
