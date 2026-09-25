"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/api-client/client";
import { usePreviewTemplateMutation, useSendTemplateMutation } from "@/lib/api-client/mutations/whatsapp-messaging.mutations";
import { whatsappTemplateListQueryOptions } from "@/lib/api-client/queries/whatsapp-templates.queries";
import { messagingCapabilityQueryOptions } from "@/lib/api-client/queries/whatsapp-conversation.queries";
import type { CustomerOrderSummary } from "@/lib/api-client/types/customers.types";
import type { WhatsAppMessageResult } from "@/lib/api-client/types/whatsapp-messaging.types";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";

const PREVIEW_DEBOUNCE_MS = 300;
const NO_ORDER = "NONE";

interface SendWhatsAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  customerName: string;
  orders: CustomerOrderSummary[];
}

export function SendWhatsAppDialog({ open, onOpenChange, leadId, customerName, orders }: SendWhatsAppDialogProps) {
  const [templateId, setTemplateId] = useState<string>("");
  const [orderId, setOrderId] = useState<string>(NO_ORDER);
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaFilename, setMediaFilename] = useState("");
  const [sendResult, setSendResult] = useState<WhatsAppMessageResult | null>(null);

  // Resets on close happen from the same user action that closes the dialog (Cancel, Done, or the
  // dialog's own dismiss), not from an effect watching `open` - avoids the extra render that
  // setting state from inside an effect body would cause.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setTemplateId("");
      setOrderId(NO_ORDER);
      setMediaUrl("");
      setMediaFilename("");
      setSendResult(null);
    }
    onOpenChange(next);
  }

  const templatesQuery = useQuery({
    ...whatsappTemplateListQueryOptions({ page: 1, pageSize: 100, status: "APPROVED" }),
    enabled: open,
  });
  // Only templates belonging to the provider this customer's conversation is on can be sent (the backend enforces the
  // same rule): a Meta conversation never offers an AiSensy template, and vice versa.
  const capabilityQuery = useQuery({ ...messagingCapabilityQueryOptions(leadId), enabled: open, retry: false });
  const templateProvider = capabilityQuery.data?.templates.provider ?? null;
  const templateBlockedMessage = capabilityQuery.data?.templates.message ?? null;
  const templates = useMemo(() => {
    const all = templatesQuery.data?.items ?? [];
    return templateProvider ? all.filter((t) => t.provider === templateProvider) : all;
  }, [templatesQuery.data, templateProvider]);
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  const previewMutation = usePreviewTemplateMutation();
  const sendMutation = useSendTemplateMutation();

  // Re-preview whenever the template or order selection changes, debounced so flipping through
  // options quickly doesn't fire a request per click.
  useEffect(() => {
    if (!templateId) return;
    const timer = setTimeout(() => {
      previewMutation.mutate({ leadId, templateId, orderId: orderId === NO_ORDER ? undefined : orderId });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, orderId, leadId]);

  const templateItems = useMemo(() => Object.fromEntries(templates.map((t) => [t.id, `${t.name} (${PROVIDER_LABELS[t.provider] ?? t.provider})`])), [templates]);
  const orderItems = useMemo(() => ({ [NO_ORDER]: "No order", ...Object.fromEntries(orders.map((o) => [o.id, o.orderNumber])) }), [orders]);

  const preview = previewMutation.data;
  const previewError = previewMutation.isError ? getErrorMessage(previewMutation.error, "Could not preview this message.") : null;

  // Client-side pre-check only, for a fast/clear error before submitting - the backend
  // (assertValidMediaUrl) is still the real, authoritative gate against a local/non-public URL.
  const mediaUrlTrimmed = mediaUrl.trim();
  const mediaUrlError = mediaUrlTrimmed && !mediaUrlTrimmed.startsWith("https://") ? "Media URL must start with https:// (AiSensy requires a publicly accessible URL)." : null;

  const canSend = Boolean(templateId) && Boolean(preview) && !previewMutation.isPending && !sendMutation.isPending && !sendResult && !mediaUrlError;

  function handleSend() {
    sendMutation.mutate(
      {
        leadId,
        templateId,
        orderId: orderId === NO_ORDER ? undefined : orderId,
        mediaUrl: mediaUrlTrimmed || undefined,
        mediaFilename: mediaFilename.trim() || undefined,
      },
      {
        onSuccess: (result) => setSendResult(result),
        onError: (error) => toast.error(getErrorMessage(error, "Could not send the message.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Send WhatsApp
          </DialogTitle>
          <DialogDescription>To {customerName}</DialogDescription>
        </DialogHeader>

        {sendResult ? (
          <SendResultView result={sendResult} onDone={() => handleOpenChange(false)} />
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Template</label>
              {templatesQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Loading templates…</p>
              ) : templateBlockedMessage ? (
                <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{templateBlockedMessage}</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {templateProvider === "META"
                    ? "No approved Meta templates yet. An admin can sync them from WhatsApp → Templates → Sync Meta templates."
                    : "No approved templates are available yet."}
                </p>
              ) : (
                <Select value={templateId || null} items={templateItems} onValueChange={(v) => setTemplateId(v ?? "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an approved template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} <span className="text-muted-foreground">({PROVIDER_LABELS[t.provider] ?? t.provider})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {templateId && selectedTemplate && selectedTemplate.variables.length > 0 && orders.length > 0 ? (
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Order (if this message needs one)</label>
                <Select value={orderId} items={orderItems} onValueChange={(v) => setOrderId(v ?? NO_ORDER)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ORDER}>No order</SelectItem>
                    {orders.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.orderNumber}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {templateId && selectedTemplate && selectedTemplate.variables.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {selectedTemplate.variables.map((v) => (
                  <Badge key={v} variant="secondary" className="font-normal">
                    {`{{${v}}}`} · auto-filled
                  </Badge>
                ))}
              </div>
            ) : null}

            {templateId ? (
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Preview</label>
                {previewMutation.isPending ? (
                  <p className="text-sm text-muted-foreground">Resolving…</p>
                ) : previewError ? (
                  <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {previewError}
                  </p>
                ) : preview ? (
                  <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{preview.resolvedBody}</p>
                ) : null}
              </div>
            ) : null}

            {templateId ? (
              <div className="grid gap-1.5 border-t pt-3">
                <Label htmlFor="wa-media-url">Attach media (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Must already be a public https link (an image, PDF, or similar). This CRM can&apos;t upload a file for you.
                </p>
                <Input
                  id="wa-media-url"
                  placeholder="https://your-cdn.example.com/file.jpg"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  aria-invalid={Boolean(mediaUrlError)}
                />
                {mediaUrlError ? <p className="text-xs text-destructive">{mediaUrlError}</p> : null}
                {mediaUrlTrimmed ? (
                  <Input
                    aria-label="Filename (optional)"
                    placeholder="Filename (optional), e.g. brochure.pdf"
                    value={mediaFilename}
                    onChange={(e) => setMediaFilename(e.target.value)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {!sendResult ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSend} disabled={!canSend}>
              {sendMutation.isPending ? "Sending…" : "Send WhatsApp"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SendResultView({ result, onDone }: { result: WhatsAppMessageResult; onDone: () => void }) {
  const failed = result.status === "FAILED";
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      {failed ? (
        <>
          <CircleAlert className="size-8 text-destructive" />
          <p className="font-medium">Message failed</p>
          <p className="text-sm text-muted-foreground">Reason: {result.errorMessage ?? "The provider rejected this message."}</p>
        </>
      ) : (
        <>
          <CircleCheck className="size-8 text-emerald-600 dark:text-emerald-400" />
          <p className="font-medium">Message sent</p>
          <p className="text-sm text-muted-foreground">Status: {result.status}</p>
        </>
      )}
      <Button onClick={onDone} className="mt-2">
        Done
      </Button>
    </div>
  );
}
