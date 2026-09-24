import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { AutomationConfig, UpdateAutomationConfigInput, WhatsAppAutomationType } from "../types/whatsapp-automations.types";

export const whatsappAutomationsApi = {
  async list(): Promise<AutomationConfig[]> {
    const res = await apiClient.get<ApiEnvelope<AutomationConfig[]>>("/whatsapp/automations");
    return res.data.data;
  },
  async update(automationType: WhatsAppAutomationType, input: UpdateAutomationConfigInput): Promise<AutomationConfig> {
    const res = await apiClient.patch<ApiEnvelope<AutomationConfig>>(`/whatsapp/automations/${automationType}`, input);
    return res.data.data;
  },
};
