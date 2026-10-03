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
import { TemplatePicker } from "@/components/whatsapp/template-picker";
import { getErrorMessage } from "@/lib/api-client/client";
import { usePreviewTemplateMutation, useSendTemplateMutation } from "@/lib/api-client/mutations/whatsapp-messaging.mutations";
import { whatsappTemplateListQueryOptions } from "@/lib/api-client/queries/whatsapp-templates.queries";
import type { CustomerOrderSummary } from "@/lib/api-client/types/customers.types";
import type { TemplateVariableField, WhatsAppMessageResult } from "@/lib/api-client/types/whatsapp-messaging.types";
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
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
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
      setManualValues({});
      setSendResult(null);
    }
    onOpenChange(next);
  }

  // A different template has different variables entirely - values typed for one template are never
  // carried over as if they meant the same thing for another.
  function handleTemplateChange(next: string) {
    setTemplateId(next);
    setManualValues({});
  }

  // Every APPROVED Meta template is offered here, never narrowed by which lead/conversation this
  // dialog happens to be open for (no "customer must already have a conversation" filter, and no
  // per-lead provider-match pre-filter - that redundant client-side copy was removed in favor of the
  // one real check, server-side, in loadAndResolve). Filtered to provider: META because Meta Cloud
  // API is the CRM's only active send path for a signed-in user (see resolveSendProvider) - an
  // AiSensy template would list here but always fail to send, which is worse than not listing it.
  const templatesQuery = useQuery({
    ...whatsappTemplateListQueryOptions({ page: 1, pageSize: 100, status: "APPROVED", provider: "META" }),
    enabled: open,
  });
  const templates = templatesQuery.data?.items ?? [];
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  // Two separate calls to the same preview endpoint, on purpose:
  //
  // `baselineMutation` learns the template's variable STRUCTURE (names, order, crm-vs-manual
  // classification - whatsapp.variable-resolver.ts's classifyVariable, the single shared source of
  // truth) exactly once per template/order selection - never on a keystroke. The input list is
  // rendered from this alone, so its length/order/identity never changes while typing, which is what
  // actually keeps focus stable: React only remounts a field's <Input> if the list around it changes
  // shape, and nothing here ever does that mid-typing.
  //
  // `previewMutation` re-resolves the actual message text as manual values are typed (debounced), for
  // the Preview block only - it never drives what inputs are rendered.
  const baselineMutation = usePreviewTemplateMutation();
  const previewMutation = usePreviewTemplateMutation();
  const sendMutation = useSendTemplateMutation();

  useEffect(() => {
    if (!templateId) return;
    baselineMutation.mutate({ leadId, templateId, orderId: orderId === NO_ORDER ? undefined : orderId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, orderId, leadId]);

  // Debounced so continuous typing fires one request per pause, not one per keystroke.
  useEffect(() => {
    if (!templateId) return;
    const timer = setTimeout(() => {
      previewMutation.mutate({ leadId, templateId, orderId: orderId === NO_ORDER ? undefined : orderId, manualValues });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, orderId, leadId, manualValues]);

  const orderItems = useMemo(() => ({ [NO_ORDER]: "No order", ...Object.fromEntries(orders.map((o) => [o.id, o.orderNumber])) }), [orders]);

  // Stable structure: the field list a person types into, fixed for as long as the template/order
  // selection is unchanged. Falls back to the template's own (unclassified) variable list before the
  // first baseline response lands, so fields appear immediately rather than popping in.
  const fields: TemplateVariableField[] = baselineMutation.data?.fields ?? (selectedTemplate?.variables.map((name) => ({ name, source: "crm" as const, value: null })) ?? []);
  // A field still needs a value if it has neither a CRM-resolved value nor anything typed for it yet -
  // computed client-side from state already in hand, so the Send button's enabled state never lags
  // behind what's on screen waiting for a network round trip.
  const isFieldMissing = (f: TemplateVariableField) => !manualValues[f.name]?.trim() && f.value === null;
  const missingRequiredFields = fields.filter(isFieldMissing);

  // Keeps the last successfully resolved message visible while a newer one is still in flight,
  // instead of blanking out to "Resolving…" on every keystroke's debounced re-check.
  const preview = previewMutation.data;
  const previewError = previewMutation.isError ? getErrorMessage(previewMutation.error, "Could not preview this message.") : null;

  // Client-side pre-check only, for a fast/clear error before submitting - the backend
  // (assertValidMediaUrl) is still the real, authoritative gate against a local/non-public URL.
  const mediaUrlTrimmed = mediaUrl.trim();
  const mediaUrlError = mediaUrlTrimmed && !mediaUrlTrimmed.startsWith("https://") ? "Media URL must start with https:// - it needs to be a publicly accessible link." : null;

  const canSend =
    Boolean(templateId) &&
    Boolean(preview) &&
    missingRequiredFields.length === 0 &&
    !sendMutation.isPending &&
    !sendResult &&
    !mediaUrlError;

  function handleSend() {
    sendMutation.mutate(
      {
        leadId,
        templateId,
        orderId: orderId === NO_ORDER ? undefined : orderId,
        mediaUrl: mediaUrlTrimmed || undefined,
        mediaFilename: mediaFilename.trim() || undefined,
        manualValues,
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
              ) : templatesQuery.isError ? (
                <p role="alert" className="text-sm text-destructive">{getErrorMessage(templatesQuery.error, "Could not load templates.")}</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No approved templates yet. An admin can create/submit one from WhatsApp → Templates, or sync approved Meta templates from there.
                </p>
              ) : (
                <TemplatePicker templates={templates} value={templateId} onChange={handleTemplateChange} />
              )}
            </div>

            {selectedTemplate ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{selectedTemplate.name}</p>
                  <p className="text-xs text-muted-foreground">{PROVIDER_LABELS[selectedTemplate.provider] ?? selectedTemplate.provider}</p>
                </div>
                <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                  Approved
                </Badge>
              </div>
            ) : null}

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

            {templateId && fields.length > 0 ? (
              <div className="grid gap-2.5">
                <label className="text-sm font-medium">Variables</label>
                {fields.map((field) => (
                  <div key={field.name} className="grid gap-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-muted-foreground">{`{{${field.name}}}`}</span>
                      {field.source === "crm" ? (
                        <Badge variant="secondary" className="font-normal">
                          Auto-filled
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-400 font-normal text-amber-700 dark:text-amber-400">
                          Required input
                        </Badge>
                      )}
                    </div>
                    <Input
                      value={manualValues[field.name] ?? field.value ?? ""}
                      placeholder={field.source === "crm" ? "Resolved automatically from customer/order data" : `Enter a value for ${field.name}`}
                      onChange={(e) => setManualValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                      aria-invalid={isFieldMissing(field)}
                    />
                    {isFieldMissing(field) ? <p className="text-xs text-destructive">Value required for {field.name}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {templateId ? (
              <div className="grid gap-1.5">
                <label className="flex items-center gap-2 text-sm font-medium">
                  Preview
                  {/* A quiet in-progress hint, not a replacement for the text below - the last
                      resolved message stays visible the whole time a newer one is still loading, so
                      typing never blanks the preview out or makes it appear to blink. */}
                  {previewMutation.isPending ? <span className="text-xs font-normal text-muted-foreground">Updating…</span> : null}
                </label>
                {previewError && !preview ? (
                  <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {previewError}
                  </p>
                ) : preview ? (
                  <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{preview.resolvedBody}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Resolving…</p>
                )}
              </div>
            ) : null}

            {/* Media attachment is currently only wired through the AiSensy Campaign API - Meta's
                Send Message API call (whatsapp.meta.provider.ts's sendTemplateMessage) does not accept
                a media field at all, so it would be silently dropped. Shown only when it would
                actually reach the provider, driven by the selected template's own stored provider -
                never a user-facing provider choice. */}
            {selectedTemplate?.provider === "AISENSY" ? (
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
