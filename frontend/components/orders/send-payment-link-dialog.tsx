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
import { whatsappTemplateListQueryOptions } from "@/lib/api-client/queries/whatsapp-templates.queries";
import type { WhatsAppMessageResult } from "@/lib/api-client/types/whatsapp-messaging.types";

const PREVIEW_DEBOUNCE_MS = 300;
// The placeholder the backend fills with this order's open payment link; a template without it would not deliver the link.
const PAYMENT_LINK_VARIABLE = "payment_link";

interface SendPaymentLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paymentId: string;
  orderId: string;
  leadId: string;
  customerName: string;
}

export function SendPaymentLinkDialog({ open, onOpenChange, paymentId, orderId, leadId, customerName }: SendPaymentLinkDialogProps) {
  const [templateId, setTemplateId] = useState("");
  const [result, setResult] = useState<WhatsAppMessageResult | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTemplateId("");
      setResult(null);
    }
    onOpenChange(next);
  }

  const templatesQuery = useQuery({ ...whatsappTemplateListQueryOptions({ page: 1, pageSize: 100, status: "APPROVED" }), enabled: open });
  // Only approved templates that contain {{payment_link}} can deliver the link.
  const templates = useMemo(() => (templatesQuery.data?.items ?? []).filter((t) => t.variables.includes(PAYMENT_LINK_VARIABLE)), [templatesQuery.data]);

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
  const canSend = Boolean(templateId) && Boolean(preview.data) && !preview.isPending && !send.isPending && !result;

  function handleSend() {
    send.mutate(
      { paymentId, templateId },
      { onSuccess: (sent) => setResult(sent), onError: (error) => toast.error(getErrorMessage(error, "Could not send the payment link.")) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Send payment link on WhatsApp
          </DialogTitle>
          <DialogDescription>To {customerName}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            {result.status === "FAILED" ? (
              <>
                <CircleAlert className="size-8 text-destructive" />
                <p className="font-medium">Message failed</p>
                <p className="text-sm text-muted-foreground">Reason: {result.errorMessage ?? "The provider rejected this message."}</p>
              </>
            ) : (
              <>
                <CircleCheck className="size-8 text-emerald-600 dark:text-emerald-400" />
                <p className="font-medium">Payment link sent</p>
                <p className="text-sm text-muted-foreground">Status: {result.status}</p>
              </>
            )}
            <Button onClick={() => handleOpenChange(false)} className="mt-2">
              Done
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <label htmlFor="payment-link-template" className="text-sm font-medium">
                Template
              </label>
              {templatesQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No approved template contains <code>{`{{${PAYMENT_LINK_VARIABLE}}}`}</code> yet. Ask an admin to add one under WhatsApp templates.
                </p>
              ) : (
                <NativeSelect id="payment-link-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">Select a template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>

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
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSend} disabled={!canSend}>
              {send.isPending ? "Sending…" : "Send payment link"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
