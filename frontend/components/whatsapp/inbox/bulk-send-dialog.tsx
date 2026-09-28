"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/api-client/client";
import { usePreviewTemplateMutation } from "@/lib/api-client/mutations/whatsapp-messaging.mutations";
import { useBulkClassifyMutation, useBulkSendMutation } from "@/lib/api-client/mutations/whatsapp-bulk-send.mutations";
import { whatsappTemplateListQueryOptions } from "@/lib/api-client/queries/whatsapp-templates.queries";
import type { TemplateVariableField } from "@/lib/api-client/types/whatsapp-messaging.types";
import type { BulkClassifyResult, BulkRecipientStatus, BulkSendResult } from "@/lib/api-client/types/whatsapp-bulk-send.types";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";

const PREVIEW_DEBOUNCE_MS = 300;

const STATUS_LABELS: Record<BulkRecipientStatus, string> = {
  READY: "Ready",
  MISSING_VARIABLE: "Missing information",
  OPTED_OUT: "WhatsApp opted out",
  INVALID_PHONE: "No valid phone number",
  TEMPLATE_NOT_SENDABLE: "Template not sendable",
  PROVIDER_ERROR: "Provider issue",
  CUSTOMER_DEACTIVATED: "Customer deactivated",
};

type Step = "compose" | "review" | "result";

// Parts 3-5 (WhatsApp Inbox): the "select chats -> Send Template" bulk flow. Reuses the exact same
// template list, variable classification (whatsapp.variable-resolver.ts's classifyVariable, surfaced
// through the same previewTemplate endpoint the single Send WhatsApp dialog uses) and, for the actual
// send, the same per-message WhatsAppMessagingService path via the bulk-send endpoints - never a
// second messaging engine, never a silent skip of an ineligible recipient.
export function BulkSendDialog({
  open,
  onOpenChange,
  leadIds,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadIds: string[];
  onSent?: () => void;
}) {
  const [step, setStep] = useState<Step>("compose");
  const [templateId, setTemplateId] = useState("");
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [classifyResult, setClassifyResult] = useState<BulkClassifyResult | null>(null);
  const [sendResult, setSendResult] = useState<BulkSendResult | null>(null);

  function reset() {
    setStep("compose");
    setTemplateId("");
    setManualValues({});
    setClassifyResult(null);
    setSendResult(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const templatesQuery = useQuery({ ...whatsappTemplateListQueryOptions({ page: 1, pageSize: 100, status: "APPROVED" }), enabled: open });
  const templates = templatesQuery.data?.items ?? [];
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  // Only used to learn the template's variable classification (auto-filled vs needs a typed value) -
  // the single shared source of truth (whatsapp.variable-resolver.ts) - not to validate every
  // recipient; that is what the bulk-classify step below is for. Run against the first selected
  // chat only, since every recipient shares the same template/manual-value classification.
  const fieldPreview = usePreviewTemplateMutation();
  useEffect(() => {
    if (!templateId || leadIds.length === 0) return;
    const timer = setTimeout(() => {
      fieldPreview.mutate({ leadId: leadIds[0]!, templateId, manualValues });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, manualValues, leadIds[0]]);

  const fields: TemplateVariableField[] = fieldPreview.data?.fields ?? (selectedTemplate?.variables.map((name) => ({ name, source: "crm" as const, value: null })) ?? []);
  const manualFields = fields.filter((f) => f.source === "manual");
  const missingManual = manualFields.some((f) => !manualValues[f.name]?.trim());

  const classify = useBulkClassifyMutation();
  const send = useBulkSendMutation();

  function handleReview() {
    classify.mutate(
      { leadIds, templateId, manualValues },
      {
        onSuccess: (result) => {
          setClassifyResult(result);
          setStep("review");
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not review recipients.")),
      },
    );
  }

  function handleSend() {
    send.mutate(
      { leadIds, templateId, manualValues },
      {
        onSuccess: (result) => {
          setSendResult(result);
          setStep("result");
          onSent?.();
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not send this bulk message.")),
      },
    );
  }

  const readyCount = classifyResult?.summary.READY ?? 0;
  // One real, resolved example - the first READY recipient's actual substituted body (never a generic
  // hardcoded preview) - so the review screen shows the real message before anyone confirms sending it.
  const previewExample = classifyResult?.recipients.find((r) => r.status === "READY" && r.resolvedBody);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Bulk WhatsApp
          </DialogTitle>
          <DialogDescription>{leadIds.length} chat{leadIds.length === 1 ? "" : "s"} selected</DialogDescription>
        </DialogHeader>

        {step === "compose" ? (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Template</label>
              {templatesQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No approved templates are available yet.</p>
              ) : (
                <Select
                  value={templateId || null}
                  items={Object.fromEntries(templates.map((t) => [t.id, `${t.name} (${PROVIDER_LABELS[t.provider] ?? t.provider})`]))}
                  onValueChange={(v) => {
                    setTemplateId(v ?? "");
                    setManualValues({});
                  }}
                >
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

            {templateId && manualFields.length > 0 ? (
              <div className="grid gap-2.5">
                <label className="text-sm font-medium">Variables</label>
                {fields.map((field) => (
                  <div key={field.name} className="grid gap-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-muted-foreground">{`{{${field.name}}}`}</span>
                      {field.source === "crm" ? (
                        <Badge variant="secondary" className="font-normal">
                          Auto-filled per customer
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-400 font-normal text-amber-700 dark:text-amber-400">
                          Required input
                        </Badge>
                      )}
                    </div>
                    {field.source === "manual" ? (
                      <Input
                        value={manualValues[field.name] ?? ""}
                        placeholder={`Enter a value for ${field.name} (same for every recipient)`}
                        onChange={(e) => setManualValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">Resolved individually from each customer&apos;s own data.</p>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : step === "review" && classifyResult ? (
          <div className="grid gap-3 py-2">
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-lg border p-2">
                <p className="text-lg font-semibold">{leadIds.length}</p>
                <p className="text-xs text-muted-foreground">Recipients</p>
              </div>
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                <p className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">{readyCount}</p>
                <p className="text-xs text-muted-foreground">Ready to send</p>
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
                <p className="text-lg font-semibold text-amber-700 dark:text-amber-400">{leadIds.length - readyCount}</p>
                <p className="text-xs text-muted-foreground">Excluded</p>
              </div>
            </div>

            {previewExample ? (
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Message preview <span className="font-normal text-muted-foreground">(example: {previewExample.name})</span></label>
                <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{previewExample.resolvedBody}</p>
              </div>
            ) : null}

            <div className="max-h-64 overflow-y-auto rounded-lg border">
              <ul className="divide-y">
                {classifyResult.recipients.map((r) => (
                  <li key={r.leadId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="flex items-center gap-2 truncate">
                      {r.status === "READY" ? (
                        <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <CircleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      )}
                      <span className="truncate">{r.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{r.status === "READY" ? "Ready" : `${STATUS_LABELS[r.status]}${r.reason ? ` — ${r.reason}` : ""}`}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : step === "result" && sendResult ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CircleCheck className="size-8 text-emerald-600 dark:text-emerald-400" />
            <p className="font-medium">
              Sent to {sendResult.sent} customer{sendResult.sent === 1 ? "" : "s"}
            </p>
            <p className="text-sm text-muted-foreground">
              {sendResult.failed > 0 ? `${sendResult.failed} failed. ` : ""}
              {sendResult.skipped > 0 ? `${sendResult.skipped} skipped (not ready).` : ""}
            </p>
            <div className="max-h-56 w-full overflow-y-auto rounded-lg border text-left">
              <ul className="divide-y">
                {sendResult.recipients.map((r) => (
                  <li key={r.leadId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="truncate">{r.name}</span>
                    <span className={`shrink-0 text-xs ${r.status === "SENT" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                      {r.status === "SENT" ? "Sent" : r.reason ?? STATUS_LABELS[r.status as BulkRecipientStatus]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {step === "compose" ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleReview} disabled={!templateId || missingManual || classify.isPending}>
                {classify.isPending ? "Reviewing…" : "Review Recipients"}
              </Button>
            </>
          ) : step === "review" ? (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("compose")}>
                Back
              </Button>
              <Button type="button" onClick={handleSend} disabled={readyCount === 0 || send.isPending}>
                {send.isPending ? "Sending…" : `Send to ${readyCount} customer${readyCount === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
