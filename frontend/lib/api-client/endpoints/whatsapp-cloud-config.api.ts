import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  SaveWhatsAppCloudConfigPayload,
  TestWhatsAppCloudConfigResult,
  WhatsAppCloudConfig,
  WhatsAppCloudConfigResult,
} from "../types/whatsapp-cloud-config.types";

export const whatsappCloudConfigApi = {
  async getConfig(): Promise<WhatsAppCloudConfigResult> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppCloudConfigResult>>("/whatsapp/cloud-config");
    return res.data.data;
  },

  async saveConfig(payload: SaveWhatsAppCloudConfigPayload): Promise<WhatsAppCloudConfig> {
    const res = await apiClient.post<ApiEnvelope<WhatsAppCloudConfig>>("/whatsapp/cloud-config", payload);
    return res.data.data;
  },

  async testConnection(): Promise<TestWhatsAppCloudConfigResult> {
    const res = await apiClient.post<ApiEnvelope<TestWhatsAppCloudConfigResult>>("/whatsapp/cloud-config/test");
    return res.data.data;
  },

  async resetConfig(): Promise<void> {
    await apiClient.delete("/whatsapp/cloud-config");
  },
};
