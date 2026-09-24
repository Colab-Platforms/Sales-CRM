// Masked shape only - the backend never returns accessToken/appSecret/verifyToken/geminiApiKey, see
// backend/src/modules/whatsapp/whatsapp.cloud-config.service.ts's toPublic().
export interface WhatsAppCloudConfig {
  id: string;
  phoneNumberId: string;
  businessAccountId: string;
  displayPhoneNumber: string | null;
  businessName: string | null;
  isActive: boolean;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  hasWebhookVerifyToken: boolean;
  aiEnabled: boolean;
  aiProvider: "gemini";
  aiModel: string | null;
  hasGeminiApiKey: boolean;
  decryptable: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Non-secret facts the screen needs whether or not anything is configured yet. */
export interface WhatsAppCloudConfigMeta {
  webhookUrl: string;
  defaultAiModel: string;
}

export type WhatsAppCloudConfigResult =
  | ({ configured: false } & WhatsAppCloudConfigMeta)
  | ({ configured: true; config: WhatsAppCloudConfig } & WhatsAppCloudConfigMeta);

export interface SaveWhatsAppCloudConfigPayload {
  phoneNumberId: string;
  businessAccountId: string;
  displayPhoneNumber?: string;
  businessName?: string;
  isActive?: boolean;
  // A blank/omitted secret keeps the stored one when replacing an existing config.
  credentials: {
    accessToken?: string;
    appSecret?: string;
    verifyToken?: string;
  };
  ai?: {
    enabled: boolean;
    provider?: "gemini";
    model?: string;
    geminiApiKey?: string;
  };
  confirmOverwrite?: boolean;
}

export interface TestWhatsAppCloudConfigResult {
  success: boolean;
  message: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  businessAccountName?: string;
}
