import { useMutation, useQueryClient } from "@tanstack/react-query";
import { whatsappBulkSendApi } from "../endpoints/whatsapp-bulk-send.api";
import { customersKeys } from "../queries/customers.queries";
import { whatsappHistoryKeys } from "../queries/whatsapp-history.queries";
import { whatsappKeys } from "../queries/whatsapp.queries";
import type { BulkClassifyInput, BulkClassifyResult, BulkSendInput, BulkSendResult } from "../types/whatsapp-bulk-send.types";

export function useBulkClassifyMutation() {
  return useMutation<BulkClassifyResult, unknown, BulkClassifyInput>({
    mutationFn: (input) => whatsappBulkSendApi.classify(input),
  });
}

export function useBulkSendMutation() {
  const queryClient = useQueryClient();
  return useMutation<BulkSendResult, unknown, BulkSendInput>({
    mutationFn: (input) => whatsappBulkSendApi.send(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customersKeys.all });
      queryClient.invalidateQueries({ queryKey: whatsappKeys.all });
      queryClient.invalidateQueries({ queryKey: whatsappHistoryKeys.all });
    },
  });
}
