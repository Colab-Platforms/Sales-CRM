"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { useSendPaymentLinkMutation } from "@/lib/api-client/mutations/integrations.mutations";
import { usePreviewTemplateMutation } from "@/lib/api-client/mutations/whatsapp-messaging.mutations";
import { whatsAppPaymentOptionsQueryOptions } from "@/lib/api-client/queries/orders.queries";
import { NO_WHATSAPP, selectedTemplate } from "@/lib/whatsapp-payment";
import type { WhatsAppMessageResult } from "@/lib/api-client/types/whatsapp-messaging.types";

const PREVIEW_DEBOUNCE_MS = 300;
// The placeholder the backend fills with this order's open payment link (every template offered here carries it).
const PAYMENT_LINK_VARIABLE = "payment_link";

interface SendPaymentLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paymentId: string;
  orderId: string;
  leadId: string;
  customerName: string;
}

interface BodyProps {
  paymentId: string;
  orderId: string;
  leadId: string;
  customerName?: string;
  onClose: () => void;
}

/** What the dialog shows: the WhatsApp Template dropdown, consent, preview and the send button. Mounted only while the dialog is open (so it starts fresh each time). */
export function SendPaymentLinkBody({ paymentId, orderId, leadId, onClose }: BodyProps) {
  const [pickedId, setPickedId] = useState("");
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<WhatsAppMessageResult | null>(null);

  // The server lists ONLY approved Meta templates with a real Meta template id that carry {{payment_link}} (prepaid_template first).
  const templatesQuery = useQuery(whatsAppPaymentOptionsQueryOptions(leadId));
  const options = templatesQuery.data ?? null;
  const templates = useMemo(() => options?.templates ?? [], [options]);
  const selected = selectedTemplate(options, { ...NO_WHATSAPP, templateId: pickedId || null });
  const templateId = selected?.id ?? "";
  // First-contact consent: nothing recorded as OPTED_IN -> the telecaller confirms it here (the server records it); OPTED_OUT is never overridden.
  const consentRecorded = options?.consent === "OPTED_IN";
  const optedOut = options?.consent === "OPTED_OUT";
  // A customer who has never been messaged on WhatsApp is a business-initiated FIRST contact: recorded (or just-confirmed) consent is required,
  // and an opt-out can never be overridden. For a customer already in a conversation the existing rules apply (nothing extra is required).
  const firstContact = options ? options.hasConversation === false : false;
  const consentBlock = firstContact ? (optedOut ? "This customer has opted out of WhatsApp messages. Update their consent through the consent flow first." : !consentRecorded && !consent ? "Confirm that the customer has agreed to receive WhatsApp updates to send the first WhatsApp message." : null) : null;

  const preview = usePreviewTemplateMutation();
  const send = useSendPaymentLinkMutation();
  const { mutate: runPreview } = preview;

  // Re-preview when the template changes, debounced so flipping through options quickly does not fire a request per click.
  useEffect(() => {
    if (!templateId) return;
    const timer = setTimeout(() => runPreview({ leadId, templateId, orderId }), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [templateId, leadId, orderId, runPreview]);

  const previewError = preview.isError ? getErrorMessage(preview.error, "Could not preview this message.") : null;
  const canSend = Boolean(templateId) && Boolean(preview.data) && !preview.isPending && !send.isPending && !result && !consentBlock;

  function handleSend() {
    send.mutate(
      { paymentId, templateId, whatsappConsent: !consentRecorded && consent ? true : undefined },
      { onSuccess: (sent) => setResult(sent), onError: (error) => toast.error(getErrorMessage(error, "Could not send the payment link.")) },
    );
  }

  return (
    <>
        {result ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            {result.status === "FAILED" ? (
              <>
                <CircleAlert className="size-8 text-destructive" />
                <p className="font-medium">Message failed</p>
                <p className="text-sm text-muted-foreground">Reason: {result.errorMessage ?? "The provider rejected this message."} You can send it again.</p>
              </>
            ) : (
              <>
                <CircleCheck className="size-8 text-emerald-600 dark:text-emerald-400" />
                <p className="font-medium">Payment link sent</p>
                <p className="text-sm text-muted-foreground">Status: {result.status}</p>
                {result.templateName ? (
                  <p className="text-sm text-muted-foreground">
                    Template: <code className="font-mono text-foreground">{result.templateName}</code>
                  </p>
                ) : null}
              </>
            )}
            <Button onClick={() => onClose()} className="mt-2">
              Done
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <label htmlFor="payment-link-template" className="text-sm font-medium">
                WhatsApp Template
              </label>
              {templatesQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No approved template contains <code>{`{{${PAYMENT_LINK_VARIABLE}}}`}</code> yet. Ask an admin to add one under WhatsApp templates.
                </p>
              ) : (
                <NativeSelect id="payment-link-template" value={templateId} onChange={(e) => setPickedId(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.language}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>

            {templateId && !consentRecorded ? (
              <div className="grid gap-1">
                <p className="text-sm text-amber-700 dark:text-amber-400">{optedOut ? "Customer has opted out of WhatsApp messages. Update their consent through the consent flow first." : "Customer has not given WhatsApp consent."}</p>
                {optedOut ? null : (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span>
                      Customer has agreed to receive WhatsApp updates
                      <span className="block text-xs text-muted-foreground">Required before sending a business-initiated WhatsApp message.</span>
                    </span>
                  </label>
                )}
              </div>
            ) : null}

            {consentBlock ? (
              <p role="alert" className="text-xs text-destructive">
                {consentBlock}
              </p>
            ) : null}

            {templateId ? (
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Preview</span>
                {preview.isPending ? (
                  <p className="text-sm text-muted-foreground">Resolving…</p>
                ) : previewError ? (
                  <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {previewError}
                  </p>
                ) : preview.data ? (
                  <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words">{preview.data.resolvedBody}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {!result ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose()}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSend} disabled={!canSend}>
              {send.isPending ? "Sending…" : "Send Payment Link"}
            </Button>
          </DialogFooter>
        ) : null}
    </>
  );
}

export function SendPaymentLinkDialog({ open, onOpenChange, paymentId, orderId, leadId, customerName }: SendPaymentLinkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Send payment link on WhatsApp
          </DialogTitle>
          <DialogDescription>To {customerName}</DialogDescription>
        </DialogHeader>
        {open ? <SendPaymentLinkBody paymentId={paymentId} orderId={orderId} leadId={leadId} customerName={customerName} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
