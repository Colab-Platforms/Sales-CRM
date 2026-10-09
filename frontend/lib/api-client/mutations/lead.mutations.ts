import { useMutation, useQueryClient } from "@tanstack/react-query";
import { leadApi } from "../endpoints/lead.api";
import { leadKeys } from "../queries/lead.queries";
import { customersKeys } from "../queries/customers.queries";
import { tasksKeys } from "../queries/tasks.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import { abandonmentKeys } from "../queries/abandonment.queries";
import type {
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  BulkUpdateStatusPayload,
  CreateLeadPayload,
  Lead,
  LeadListResult,
  UpdateLeadPayload,
} from "../types/lead.types";

export function useCreateLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<Lead, unknown, CreateLeadPayload>({
    mutationFn: (payload) => leadApi.createLead(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
      // A new Lead is a new customer/contact record too (same row, no separate contact table) - the
      // Customers list and any open Customer 360 view need to see it without a manual page refresh.
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
    },
  });
}

export function useUpdateLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    Lead,
    unknown,
    { id: string; payload: UpdateLeadPayload },
    { previous: Array<[readonly unknown[], LeadListResult | undefined]> }
  >({
    mutationFn: ({ id, payload }) => leadApi.updateLead(id, payload),
    onMutate: async ({ id, payload }) => {
      await queryClient.cancelQueries({ queryKey: leadKeys.all });

      const previous = queryClient.getQueriesData<LeadListResult>({ queryKey: leadKeys.all });

      queryClient.setQueriesData<LeadListResult>({ queryKey: leadKeys.all }, (old) => {
        if (!old || !Array.isArray(old.data)) return old;
        return {
          ...old,
          data: old.data.map((lead) => (lead.id === id ? { ...lead, ...payload } : lead)),
        };
      });

      return { previous };
    },
    onError: (_err, _variables, context) => {
      context?.previous.forEach(([queryKey, data]) => {
        queryClient.setQueryData(queryKey, data);
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
      // A status change can schedule or close a follow-up reminder.
      queryClient.invalidateQueries({ queryKey: tasksKeys.all });
      // A Lead IS the customer record Customer 360 reads (same row, no separate contact table) - a
      // rename/edit here must show up immediately wherever Customer 360 is already rendered (the
      // WhatsApp Inbox's right panel, the Customer 360 page itself), not just in the leads list.
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
      // If this lead already has a real WhatsApp conversation, its row in the Inbox list shows the
      // lead's name - a rename must be reflected there too, without a manual page refresh.
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
      // The Abandoned Leads table reads this lead's workingStatus off its own query (not leadKeys) -
      // without this it only shows the update after a manual page refresh.
      queryClient.invalidateQueries({ queryKey: abandonmentKeys.all });
    },
  });
}

export function useDeleteLeadMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ id: string }, unknown, string>({
    mutationFn: (id) => leadApi.deleteLead(id),
    onSuccess: (_result, id) => {
      // Lead Detail is the Customer 360 page - same underlying record, so both caches drop it.
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
      queryClient.removeQueries({ queryKey: customersKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}

export function useBulkAssignManagerMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ assignedCount: number }, unknown, BulkAssignManagerPayload>({
    mutationFn: (payload) => leadApi.bulkAssignManager(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function useBulkAssignSalespersonMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ assignedCount: number }, unknown, BulkAssignSalespersonPayload>({
    mutationFn: (payload) => leadApi.bulkAssignSalesperson(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

export function useBulkUpdateStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ updatedCount: number }, unknown, BulkUpdateStatusPayload>({
    mutationFn: (payload) => leadApi.bulkUpdateStatus(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
      // A status change can schedule or close a follow-up reminder.
      queryClient.invalidateQueries({ queryKey: tasksKeys.all });
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
    },
  });
}

export function usePreviewImportMutation() {
  return useMutation<
    Awaited<ReturnType<typeof leadApi.previewImport>>,
    unknown,
    { file: File; columnMapping: Record<string, string> }
  >({
    mutationFn: ({ file, columnMapping }) => leadApi.previewImport(file, columnMapping),
  });
}

export function useConfirmImportMutation() {
  const queryClient = useQueryClient();

  return useMutation<Awaited<ReturnType<typeof leadApi.confirmImport>>, unknown, string>({
    mutationFn: (batchId) => leadApi.confirmImport(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}
