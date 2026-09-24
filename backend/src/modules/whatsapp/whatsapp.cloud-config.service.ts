import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { decryptJson, encryptJson } from "@/utils/crypto.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma, WhatsAppConfig } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { DEFAULT_GEMINI_MODEL } from "./whatsapp.ai.gemini.provider.js";
import { GRAPH_API_VERSION } from "./whatsapp.meta.factory.js";
import type {
  CreateWhatsAppCloudConfigBody,
  PublicWhatsAppCloudConfig,
  StoredAISettings,
  StoredWhatsAppCredentials,
  TestConnectionResult,
  WhatsAppCloudConfigMeta,
  WhatsAppCloudConfigResult,
} from "./whatsapp.cloud-config.types.js";

const REFERENCE_TYPE = "WhatsAppConfig";

export const WEBHOOK_PATH = "/api/webhooks/whatsapp-cloud";
// The address Meta must call. PUBLIC_BACKEND_URL (already documented for Cashfree's webhook) wins so a
// different deployment shows its own URL; otherwise the production Render backend.
export const DEFAULT_PUBLIC_BACKEND_URL = "https://sales-crm-3pan.onrender.com";

export function getWebhookUrl(env: Record<string, string | undefined> = process.env): string {
  const base = (env.PUBLIC_BACKEND_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_PUBLIC_BACKEND_URL;
  return `${base}${WEBHOOK_PATH}`;
}

const CONFIG_SELECT = {
  id: true,
  phoneNumberId: true,
  businessAccountId: true,
  displayPhoneNumber: true,
  businessName: true,
  isActive: true,
  credentials: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WhatsAppConfigSelect;

type ConfigRow = Prisma.WhatsAppConfigGetPayload<{ select: typeof CONFIG_SELECT }>;

const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;

class WhatsAppCloudConfigService {
  constructor(private readonly db: DbClient = prisma) {}

  private meta(): WhatsAppCloudConfigMeta {
    return { webhookUrl: getWebhookUrl(), defaultAiModel: DEFAULT_GEMINI_MODEL };
  }

  /** At most one row is ever meant to exist (enforced here, not by a DB constraint - see the schema
   *  comment on WhatsAppConfig); the most recently created one wins if that invariant is ever violated. */
  private async findConfigRow(): Promise<ConfigRow | null> {
    return this.db.whatsAppConfig.findFirst({ orderBy: { createdAt: "desc" }, select: CONFIG_SELECT });
  }

  /** null when the stored blob cannot be decrypted (rotated/missing INTEGRATION_ENCRYPTION_KEY, corrupt data). */
  private tryDecrypt(row: ConfigRow): StoredWhatsAppCredentials | null {
    try {
      return decryptJson<StoredWhatsAppCredentials>(row.credentials as string);
    } catch (error) {
      logger.error("WhatsApp Cloud API config credentials could not be decrypted", error instanceof Error ? error.message : undefined);
      return null;
    }
  }

  private toPublic(row: ConfigRow): PublicWhatsAppCloudConfig {
    const decrypted = this.tryDecrypt(row);
    const ai = decrypted?.ai;

    return {
      id: row.id,
      phoneNumberId: row.phoneNumberId,
      businessAccountId: row.businessAccountId,
      displayPhoneNumber: row.displayPhoneNumber,
      businessName: row.businessName,
      isActive: row.isActive,
      // When decryption fails we still know a credentials blob was stored, just not what it
      // contains - reported as present so the UI shows "reconfigure", not "never configured".
      hasAccessToken: decrypted ? Boolean(decrypted.accessToken) : true,
      hasAppSecret: decrypted ? Boolean(decrypted.appSecret) : true,
      hasWebhookVerifyToken: decrypted ? Boolean(decrypted.verifyToken) : true,
      aiEnabled: Boolean(ai?.enabled),
      aiProvider: "gemini",
      aiModel: ai?.model ?? null,
      hasGeminiApiKey: Boolean(ai?.geminiApiKey),
      decryptable: decrypted !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async getConfig(): Promise<WhatsAppCloudConfigResult> {
    const row = await this.findConfigRow();
    if (!row) return { configured: false, ...this.meta() };
    return { configured: true, config: this.toPublic(row), ...this.meta() };
  }

  private async recordActivity(user: AuthUser, type: ActivityType, description: string, source: ActivitySource = ActivitySource.USER): Promise<void> {
    await this.db.activity.create({
      data: { actorId: user.id, actorRole: user.role, type, referenceType: REFERENCE_TYPE, referenceId: null, source, title: "WhatsApp Cloud API configuration", description },
    });
  }

  async createConfig(user: AuthUser, data: CreateWhatsAppCloudConfigBody): Promise<PublicWhatsAppCloudConfig> {
    const existing = await this.findConfigRow();
    if (existing && !data.confirmOverwrite) {
      throw new ApiError("WhatsApp Cloud API is already configured. Resend with confirmOverwrite: true to replace it.", STATUS_CODES.CONFLICT);
    }

    // Only a decryptable stored config can donate values a blank field should keep; an undecryptable
    // one (key changed) is simply replaced, so everything must be entered again.
    const prior = existing ? this.tryDecrypt(existing) : null;

    const secrets = {
      accessToken: clean(data.credentials.accessToken) ?? prior?.accessToken,
      appSecret: clean(data.credentials.appSecret) ?? prior?.appSecret,
      verifyToken: clean(data.credentials.verifyToken) ?? prior?.verifyToken,
    };
    for (const name of ["accessToken", "appSecret", "verifyToken"] as const) {
      if (!secrets[name]) throw new ApiError(`${name} is required`, STATUS_CODES.BAD_REQUEST);
    }

    let ai: StoredAISettings | undefined = prior?.ai;
    if (data.ai) {
      const geminiApiKey = clean(data.ai.geminiApiKey) ?? prior?.ai?.geminiApiKey;
      if (data.ai.enabled && !geminiApiKey && !clean(process.env.GEMINI_API_KEY)) {
        throw new ApiError("Enter a Gemini API key to enable AI order-taking (or set GEMINI_API_KEY on the server)", STATUS_CODES.BAD_REQUEST);
      }
      ai = { enabled: data.ai.enabled, provider: "gemini", ...(clean(data.ai.model) ? { model: clean(data.ai.model) } : {}), ...(geminiApiKey ? { geminiApiKey } : {}) };
    }

    const stored: StoredWhatsAppCredentials = { accessToken: secrets.accessToken!, appSecret: secrets.appSecret!, verifyToken: secrets.verifyToken!, ...(ai ? { ai } : {}) };
    const fields = {
      phoneNumberId: data.phoneNumberId,
      businessAccountId: data.businessAccountId,
      displayPhoneNumber: data.displayPhoneNumber,
      businessName: data.businessName,
      isActive: data.isActive ?? true,
      // The one encryption mechanism the app already has (utils/crypto.ts, AES-256-GCM).
      credentials: encryptJson(stored),
    };

    // Field NAMES only ever go in the audit trail - never a value.
    const provided = [
      clean(data.credentials.accessToken) && "accessToken",
      clean(data.credentials.appSecret) && "appSecret",
      clean(data.credentials.verifyToken) && "verifyToken",
      data.ai && clean(data.ai.geminiApiKey) && "geminiApiKey",
    ].filter(Boolean);
    const aiNote = data.ai ? `; AI ${data.ai.enabled ? "enabled" : "disabled"} (gemini${clean(data.ai.model) ? `, model ${clean(data.ai.model)}` : ""})` : "";

    let row: ConfigRow;
    if (existing) {
      row = await this.db.whatsAppConfig.update({ where: { id: existing.id }, data: { ...fields, updatedById: user.id }, select: CONFIG_SELECT });
      await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_UPDATED, `${provided.length ? `${provided.join(", ")} replaced` : "Settings updated"}${aiNote}`);
    } else {
      row = await this.db.whatsAppConfig.create({ data: { ...fields, createdById: user.id, updatedById: user.id }, select: CONFIG_SELECT });
      await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_CREATED, `phoneNumberId, businessAccountId, ${provided.join(", ")} set${aiNote}`);
    }
    return this.toPublic(row);
  }

  async resetConfig(user: AuthUser): Promise<void> {
    const existing = await this.findConfigRow();
    if (!existing) throw new ApiError("WhatsApp Cloud API is not configured", STATUS_CODES.NOT_FOUND);
    await this.db.whatsAppConfig.delete({ where: { id: existing.id } });
    await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_RESET, "Configuration deleted; re-entry required");
  }

  async testConnection(user: AuthUser): Promise<TestConnectionResult> {
    const row = await this.findConfigRow();
    if (!row) throw new ApiError("WhatsApp Cloud API is not configured", STATUS_CODES.NOT_FOUND);

    const credentials = this.tryDecrypt(row);
    if (!credentials) {
      const message = "Stored credentials cannot be decrypted. Reset and re-enter the configuration.";
      await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_TESTED, `Failed: ${message}`);
      return { success: false, message };
    }

    const graph = (id: string, fields: string) =>
      fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(id)}?fields=${fields}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });

    try {
      const response = await graph(row.phoneNumberId, "display_phone_number,verified_name");
      const body = (await response.json().catch(() => null)) as Record<string, any> | null;

      if (!response.ok) {
        // Only the HTTP status and Meta's numeric error code - never Meta's free-text message or anything request-derived.
        const code = typeof body?.error?.code === "number" ? `, code ${body.error.code}` : "";
        const message = `Meta rejected the credentials (HTTP ${response.status}${code}). Check the Phone Number ID and access token.`;
        await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_TESTED, `Failed: ${message}`);
        return { success: false, message };
      }

      const displayPhoneNumber = typeof body?.display_phone_number === "string" ? body.display_phone_number : undefined;
      const verifiedName = typeof body?.verified_name === "string" ? body.verified_name : undefined;

      // WABA details are best-effort: a token that can read the phone number but not the account is still "connected".
      let businessAccountName: string | undefined;
      try {
        const wabaResponse = await graph(row.businessAccountId, "name");
        if (wabaResponse.ok) {
          const waba = (await wabaResponse.json().catch(() => null)) as Record<string, unknown> | null;
          if (typeof waba?.name === "string") businessAccountName = waba.name;
        }
      } catch {
        // ignored on purpose - see above
      }

      await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_TESTED, "Succeeded");
      return { success: true, message: "Connected", displayPhoneNumber, verifiedName, businessAccountName };
    } catch (error) {
      const message = `Could not reach Meta (${error instanceof Error ? error.name : "network error"})`;
      await this.recordActivity(user, ActivityType.WHATSAPP_CLOUD_CONFIG_TESTED, `Failed: ${message}`);
      return { success: false, message };
    }
  }
}

export default WhatsAppCloudConfigService;
export type { WhatsAppConfig };
