"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { customerDeactivationImpactQueryOptions } from "@/lib/api-client/queries/customers.queries";
import { useDeactivateCustomerMutation } from "@/lib/api-client/mutations/customers.mutations";

// Part 8 (WhatsApp Inbox): "Delete Customer" never hard-deletes - the schema has no cascade from Lead
// (orders/conversations/messages/campaign history all reference it), so a real DELETE would fail at
// the database level. This marks the profile DEACTIVATED (LeadWorkingStatus) instead; every related
// record's count is shown here so the person confirming knows exactly what does NOT get deleted.
export function DeleteCustomerDialog({
  open,
  onOpenChange,
  leadId,
  customerName,
  onDeactivated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  customerName: string;
  onDeactivated?: () => void;
}) {
  const impact = useQuery({ ...customerDeactivationImpactQueryOptions(leadId), enabled: open });
  const deactivate = useDeactivateCustomerMutation();

  function handleConfirm() {
    deactivate.mutate(
      { leadId },
      {
        onSuccess: () => {
          toast.success(`${customerName}'s profile was deactivated. Orders, conversations and messages were not deleted.`);
          onOpenChange(false);
          onDeactivated?.();
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not deactivate this customer.")),
      },
    );
  }

  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Customer?"
      destructive
      confirmLabel="Delete Customer"
      pendingLabel={deactivate.isPending ? "Deactivating…" : "Loading…"}
      // Also blocks confirmation until the impact counts have actually loaded - never let someone
      // confirm before seeing what they're affecting.
      pending={deactivate.isPending || impact.isPending}
      onConfirm={handleConfirm}
      description={
        // Dialog.Description renders a <p> - only inline content (text/spans) is valid inside it, so a
        // block-level Skeleton never belongs here even while loading.
        impact.isPending ? (
          "Loading related records…"
        ) : impact.isError ? (
          getErrorMessage(impact.error, "Could not load this customer's related records.")
        ) : impact.data ? (
          <>
            {customerName} has {impact.data.orders} order{impact.data.orders === 1 ? "" : "s"}, {impact.data.conversations} conversation{impact.data.conversations === 1 ? "" : "s"}, {impact.data.messages} message{impact.data.messages === 1 ? "" : "s"}
            {impact.data.campaignRecipients > 0 ? `, ${impact.data.campaignRecipients} campaign recipient record${impact.data.campaignRecipients === 1 ? "" : "s"}` : ""}. Deleting the profile will not delete historical orders or transactional records - the customer is deactivated, not removed.
          </>
        ) : null
      }
    />
  );
}
