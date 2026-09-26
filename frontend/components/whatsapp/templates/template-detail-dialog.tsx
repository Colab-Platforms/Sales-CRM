"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useUpdateTemplateMutation } from "@/lib/api-client/mutations/whatsapp-templates.mutations";
import { whatsappTemplateDetailQueryOptions } from "@/lib/api-client/queries/whatsapp-templates.queries";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { TemplateStatusBadge } from "./template-status-badge";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

/** Whether this row's status can ONLY have come from a real provider sync - never something a person set by hand
 *  (see whatsapp.template.validators.ts's updateTemplateSchema: a human can only ever pick DRAFT or DISABLED). A
 *  local draft can therefore never be mistaken for a provider-approved template, regardless of status. */
function isProviderReported(t: WhatsAppTemplate): boolean {
  return t.status === "APPROVED" || t.status === "PENDING" || t.status === "REJECTED" || Boolean(t.lastSyncedAt);
}

interface TemplateDetailDialogProps {
  template: WhatsAppTemplate | null;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  onEdit: (template: WhatsAppTemplate) => void;
  onDelete: (template: WhatsAppTemplate) => void;
}

export function TemplateDetailDialog({ template: initial, onOpenChange, canManage, onEdit, onDelete }: TemplateDetailDialogProps) {
  const updateMutation = useUpdateTemplateMutation();
  const detailQuery = useQuery({ ...whatsappTemplateDetailQueryOptions(initial?.id ?? ""), enabled: Boolean(initial) });
  // The list row's own data first (instant), replaced by the full detail (with usage counts) once it loads.
  const template = detailQuery.data ?? initial;

  if (!template) return null;
  const usage = template.usage;
  const hasUsage = Boolean(usage && (usage.campaigns > 0 || usage.automationConfigs > 0 || usage.messages > 0));

  const toggleDisabled = () => {
    const nextStatus = template.status === "DISABLED" ? "DRAFT" : "DISABLED";
    updateMutation.mutate(
      { id: template.id, input: { status: nextStatus } },
      {
        onSuccess: () => toast.success(nextStatus === "DISABLED" ? "Template disabled." : "Template restored to draft."),
        onError: (error) => toast.error(getErrorMessage(error, "Could not update the template's status.")),
      },
    );
  };

  return (
    <Dialog open={Boolean(template)} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {template.name}
            <TemplateStatusBadge status={template.status} />
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {isProviderReported(template) ? `Synced from ${PROVIDER_LABELS[template.provider] ?? template.provider}` : "Local draft only"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Provider</p>
              <p>{PROVIDER_LABELS[template.provider] ?? template.provider}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Language</p>
              <p>{template.language}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Category</p>
              <p>{template.category ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Quality</p>
              <p>{template.quality ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Provider template ID</p>
              <p className="break-all">{template.providerTemplateId ?? "— (local draft, never synced)"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last synced</p>
              <p>{formatDateTime(template.lastSyncedAt)}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">Body</p>
            <p className="mt-1 rounded-lg border bg-muted/30 p-3 whitespace-pre-wrap">{template.body}</p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">Variables</p>
            {template.variables.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {template.variables.map((v) => (
                  <Badge key={v} variant="secondary">
                    {`{{${v}}}`}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-muted-foreground">None</p>
            )}
          </div>

          {template.components?.header ? (
            <div>
              <p className="text-xs text-muted-foreground">Header</p>
              <p className="mt-1">
                {template.components.header.type}
                {template.components.header.text ? `: ${template.components.header.text}` : ""}
                {template.components.header.mediaUrl ? <span className="ml-1 break-all text-muted-foreground">({template.components.header.mediaUrl})</span> : null}
              </p>
            </div>
          ) : null}

          {template.components?.footer ? (
            <div>
              <p className="text-xs text-muted-foreground">Footer</p>
              <p className="mt-1 text-muted-foreground">{template.components.footer}</p>
            </div>
          ) : null}

          {template.components?.buttons?.length ? (
            <div>
              <p className="text-xs text-muted-foreground">Buttons</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {template.components.buttons.map((b, i) => (
                  <Badge key={i} variant="outline">
                    {b.text} ({b.type === "QUICK_REPLY" ? "quick reply" : b.type === "URL" ? "link" : "call"})
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {template.createdBy ? (
            <p className="text-xs text-muted-foreground">Created by {template.createdBy.name}</p>
          ) : null}

          <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center">
            <div>
              <p className="text-lg font-semibold">{usage?.campaigns ?? "—"}</p>
              <p className="text-xs text-muted-foreground">Campaigns</p>
            </div>
            <div>
              <p className="text-lg font-semibold">{usage?.automationConfigs ?? "—"}</p>
              <p className="text-xs text-muted-foreground">Automations</p>
            </div>
            <div>
              <p className="text-lg font-semibold">{usage?.messages ?? "—"}</p>
              <p className="text-xs text-muted-foreground">Messages sent</p>
            </div>
          </div>

          {hasUsage && usage ? (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {usage.campaigns > 0 ? `Used by ${usage.campaigns} campaign${usage.campaigns === 1 ? "" : "s"}${usage.campaigns > 0 ? " - cannot be deleted until that changes" : ""}. ` : ""}
                {usage.automationConfigs > 0 ? `Used by ${usage.automationConfigs} automation${usage.automationConfigs === 1 ? "" : "s"}. ` : ""}
                {usage.messages > 0 ? `${usage.messages} message${usage.messages === 1 ? " was" : "s were"} already sent with this template - editing it only affects future sends; sent history is never changed.` : ""}
              </span>
            </p>
          ) : null}
        </div>

        {canManage ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => onDelete(template)} className="mr-auto text-destructive hover:text-destructive">
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
            {(template.status === "DRAFT" || template.status === "DISABLED") && (
              <Button variant="outline" onClick={toggleDisabled} disabled={updateMutation.isPending}>
                {template.status === "DISABLED" ? "Restore to draft" : "Disable"}
              </Button>
            )}
            <Button onClick={() => onEdit(template)}>Edit</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
