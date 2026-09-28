import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { BulkClassifyInput, BulkClassifyResult, BulkSendInput, BulkSendResult } from "../types/whatsapp-bulk-send.types";

export const whatsappBulkSendApi = {
  async classify(input: BulkClassifyInput): Promise<BulkClassifyResult> {
    const res = await apiClient.post<ApiEnvelope<BulkClassifyResult>>("/whatsapp/messages/template/bulk-classify", input);
    return res.data.data;
  },
  async send(input: BulkSendInput): Promise<BulkSendResult> {
    const res = await apiClient.post<ApiEnvelope<BulkSendResult>>("/whatsapp/messages/template/bulk-send", input);
    return res.data.data;
  },
};
