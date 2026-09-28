import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customersApi } from "../endpoints/customers.api";
import { customersKeys } from "../queries/customers.queries";

export function useDeactivateCustomerMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ leadId: string; workingStatus: string }, unknown, { leadId: string }>({
    mutationFn: ({ leadId }) => customersApi.deactivate(leadId),
    onSuccess: (_, { leadId }) => {
      queryClient.invalidateQueries({ queryKey: customersKeys.detail(leadId) });
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
    },
  });
}
