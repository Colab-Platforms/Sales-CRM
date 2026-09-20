"use client";

import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useUpdateTemplateMutation } from "@/lib/api-client/mutations/whatsapp-templates.mutations";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { TemplateStatusBadge } from "./template-status-badge";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

interface TemplateDetailDialogProps {
  template: WhatsAppTemplate | null;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  onEdit: (template: WhatsAppTemplate) => void;
}

export function TemplateDetailDialog({ template, onOpenChange, canManage, onEdit }: TemplateDetailDialogProps) {
  const updateMutation = useUpdateTemplateMutation();

  if (!template) return null;

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
          <DialogTitle className="flex items-center gap-2">
            {template.name}
            <TemplateStatusBadge status={template.status} />
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

          {template.createdBy ? (
            <p className="text-xs text-muted-foreground">Created by {template.createdBy.name}</p>
          ) : null}
        </div>

        {canManage ? (
          <DialogFooter>
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
