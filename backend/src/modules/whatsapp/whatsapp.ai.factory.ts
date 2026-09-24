import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { decryptJson } from "@/utils/crypto.js";
import { logger } from "@/utils/logger.js";
import { DEFAULT_GEMINI_MODEL, GeminiAIProvider } from "./whatsapp.ai.gemini.provider.js";
import type { AIProvider } from "./whatsapp.ai.provider.js";
import type { StoredWhatsAppCredentials } from "./whatsapp.cloud-config.types.js";

type Env = Record<string, string | undefined>;

// Two sources, one result:
//  1. Settings -> WhatsApp Config ("AI Order Taking"): saved encrypted with the Meta credentials
//     (resolveAIProvider). When that section has been saved it decides: disabled -> no AI.
//  2. Environment (getAIProvider): AI_PROVIDER = "gemini" (default when unset) or "none", with
//     GEMINI_API_KEY / GEMINI_MODEL - the fallback when nothing was saved on the screen.
// null means "AI unavailable" (disabled, no key, "none", or an unknown provider) and callers
// (whatsapp.order-conversation.service.ts) then hand the conversation to a human - same "null means
// not configured, never a fake provider" contract as whatsapp.factory.ts's getWhatsAppProvider().
// Adding another provider later = one more case here plus its AIProvider implementation.

let cached: { key: string; provider: AIProvider } | null = null;

function geminiProvider(apiKey: string, modelName: string | undefined): AIProvider {
  const model = (modelName ?? "").trim() || DEFAULT_GEMINI_MODEL;
  const key = `gemini:${model}:${createHash("sha256").update(apiKey).digest("hex")}`; // a digest, so the key itself is never held as a cache key
  if (cached?.key !== key) cached = { key, provider: new GeminiAIProvider({ apiKey, model }) };
  return cached.provider;
}

export function getAIProvider(env: Env = process.env): AIProvider | null {
  const selected = (env.AI_PROVIDER ?? "gemini").trim().toLowerCase();

  if (selected === "none" || selected === "") return null;

  if (selected === "gemini") {
    const apiKey = (env.GEMINI_API_KEY ?? "").trim();
    if (!apiKey) return null;
    return geminiProvider(apiKey, env.GEMINI_MODEL);
  }

  logger.warn(`Unsupported AI_PROVIDER "${selected}" - AI order-taking is disabled (supported: gemini, none)`);
  return null;
}

/** The provider the order-taking flow should use right now: the screen's saved AI settings when
 *  present, otherwise the environment. Never throws - an unreadable config falls back to the env. */
export async function resolveAIProvider(db: DbClient = prisma, env: Env = process.env): Promise<AIProvider | null> {
  let ai: StoredWhatsAppCredentials["ai"];
  try {
    const row = await db.whatsAppConfig.findFirst({ where: { isActive: true }, orderBy: { createdAt: "desc" }, select: { credentials: true } });
    if (row) ai = decryptJson<StoredWhatsAppCredentials>(row.credentials as string).ai;
  } catch (error) {
    // Stored blob cannot be decrypted / DB hiccup: fall back to the environment rather than break replies.
    logger.error("WhatsApp AI settings could not be read from the saved configuration - using environment settings", error instanceof Error ? error.name : undefined);
  }

  if (!ai) return getAIProvider(env);
  if (!ai.enabled) return null;

  // A saved key wins; without one the server-side GEMINI_API_KEY (if any) is used.
  const apiKey = (ai.geminiApiKey ?? "").trim() || (env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return geminiProvider(apiKey, (ai.model ?? "").trim() || env.GEMINI_MODEL);
}
