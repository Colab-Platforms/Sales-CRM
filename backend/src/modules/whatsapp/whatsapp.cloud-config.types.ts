// WhatsApp Cloud API (Meta, official) + AI order-taking configuration - request/response shapes.
// Response types never carry a real secret value, only booleans (same convention as
// integrations.types.ts / toPublicSource()).

export interface WhatsAppCloudCredentialsInput {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

export type AIProviderChoice = "gemini";

/** AI order-taking settings. Stored inside the same encrypted credentials blob as the Meta secrets
 *  (so no schema change and one encryption mechanism); only `enabled`/`provider`/`model` are ever
 *  echoed back, never `geminiApiKey`. */
export interface StoredAISettings {
  enabled: boolean;
  provider: AIProviderChoice;
  model?: string;
  geminiApiKey?: string;
}

/** What is actually encrypted and stored in WhatsAppConfig.credentials. */
export interface StoredWhatsAppCredentials extends WhatsAppCloudCredentialsInput {
  ai?: StoredAISettings;
}

export interface CreateWhatsAppCloudConfigBody {
  phoneNumberId: string;
  businessAccountId: string;
  displayPhoneNumber?: string;
  businessName?: string;
  isActive?: boolean;
  /** On a NEW config all three are required. When replacing an existing, decryptable config a blank
   *  (omitted) secret keeps the stored one - the UI never shows secrets back, so it cannot resend them. */
  credentials: Partial<WhatsAppCloudCredentialsInput>;
  ai?: {
    enabled: boolean;
    provider?: AIProviderChoice;
    model?: string;
    /** Omitted/blank keeps the stored key. */
    geminiApiKey?: string;
  };
  /** Required to overwrite an existing config - never silently overwritten (see whatsapp.cloud-config.service.ts). */
  confirmOverwrite?: boolean;
}

/** Masked shape returned by GET/POST - see toPublic() in whatsapp.cloud-config.service.ts. */
export interface PublicWhatsAppCloudConfig {
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
  aiProvider: AIProviderChoice;
  /** null = no model saved, the default (defaultAiModel) applies. */
  aiModel: string | null;
  hasGeminiApiKey: boolean;
  /** false only when a stored config row exists but its credentials blob could not be decrypted
   *  (wrong/rotated INTEGRATION_ENCRYPTION_KEY, corrupt data) - the UI shows a "reset and re-enter" state. */
  decryptable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Non-secret facts the screen needs whether or not anything is configured yet. */
export interface WhatsAppCloudConfigMeta {
  webhookUrl: string;
  defaultAiModel: string;
}

export type WhatsAppCloudConfigResult =
  | ({ configured: false } & WhatsAppCloudConfigMeta)
  | ({ configured: true; config: PublicWhatsAppCloudConfig } & WhatsAppCloudConfigMeta);

export interface TestConnectionResult {
  success: boolean;
  message: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  businessAccountName?: string;
}
