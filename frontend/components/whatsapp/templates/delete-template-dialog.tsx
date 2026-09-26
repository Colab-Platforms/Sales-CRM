"use client";

import { toast } from "sonner";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useDeleteTemplateMutation } from "@/lib/api-client/mutations/whatsapp-templates.mutations";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

interface DeleteTemplateDialogProps {
  template: WhatsAppTemplate | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

// This only ever removes the CRM's own local record. No provider (Meta/AiSensy/Gupshup) has a delete API
// implemented anywhere in this codebase, so the real template - if this row was ever synced from one - is
// completely untouched and will simply reappear on the next sync.
export function DeleteTemplateDialog({ template, onOpenChange, onDeleted }: DeleteTemplateDialogProps) {
  const deleteMutation = useDeleteTemplateMutation();

  if (!template) return null;

  function handleConfirm() {
    deleteMutation.mutate(template!.id, {
      onSuccess: () => {
        toast.success("Template deleted.");
        onOpenChange(false);
        onDeleted?.();
      },
      onError: (error) => toast.error(getErrorMessage(error, "Could not delete the template.")),
    });
  }

  return (
    <ConfirmActionDialog
      open={Boolean(template)}
      onOpenChange={onOpenChange}
      title="Delete this template?"
      description={
        <>
          <span className="font-medium text-foreground">{template.name}</span> ({PROVIDER_LABELS[template.provider] ?? template.provider}) will be permanently removed from the CRM&apos;s
          own template list. This does not delete anything from {PROVIDER_LABELS[template.provider] ?? template.provider} itself - if this template was synced from there, it will simply
          reappear the next time templates are synced.
        </>
      }
      confirmLabel="Delete template"
      pendingLabel="Deleting…"
      pending={deleteMutation.isPending}
      destructive
      onConfirm={handleConfirm}
    />
  );
}
