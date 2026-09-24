import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { WhatsAppStatus } from "../types/whatsapp.types";

export const whatsappApi = {
  async status(): Promise<WhatsAppStatus> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppStatus>>("/whatsapp/status");
    return res.data.data;
  },
};
