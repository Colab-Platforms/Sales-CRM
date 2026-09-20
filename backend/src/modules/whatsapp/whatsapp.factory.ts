import { AiSensyProvider } from "./whatsapp.aisensy.provider.js";
import { loadWhatsAppConfig } from "./whatsapp.config.js";
import { GupshupProvider } from "./whatsapp.gupshup.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";

/** null when WhatsApp is not configured or misconfigured - callers must treat that as "Not
 *  Configured" and continue without sending or verifying anything, never fall back to a fake provider. */
export function getWhatsAppProvider(env: Record<string, string | undefined> = process.env): WhatsAppProvider | null {
  const config = loadWhatsAppConfig(env);
  if (!config) return null;
  return config.kind === "AISENSY" ? new AiSensyProvider(config) : new GupshupProvider(config);
}
