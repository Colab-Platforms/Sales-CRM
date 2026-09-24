import { prisma } from "@/lib/prisma.js";
import { decryptJson } from "@/utils/crypto.js";
import { logger } from "@/utils/logger.js";
import type { DbClient } from "@/lib/leadScope.js";
import { MetaCloudApiProvider, type MetaCloudApiCredentials } from "./whatsapp.meta.provider.js";
import type { WhatsAppCloudCredentialsInput } from "./whatsapp.cloud-config.types.js";

// Not hardcoded: an admin/operator can pin a different Graph API version via env without a code
// change or a DB migration. Default is a recent, stable Meta Graph API version.
export const GRAPH_API_VERSION = (process.env.META_GRAPH_API_VERSION ?? "v21.0").trim();

/** Deliberately separate from whatsapp.factory.ts's getWhatsAppProvider() (sync, env-based,
 *  AiSensy/Gupshup only) - Meta's config lives in the database and needs an async lookup, so it
 *  cannot share that factory without making every existing AiSensy/Gupshup call site async too.
 *  Returns null for "not configured", "inactive", and "cannot be decrypted" alike - callers must
 *  treat all three as "do nothing, report unavailable", same contract as getWhatsAppProvider(). */
export async function getMetaWhatsAppProvider(db: DbClient = prisma): Promise<MetaCloudApiProvider | null> {
  const row = await db.whatsAppConfig.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
    select: { phoneNumberId: true, businessAccountId: true, credentials: true },
  });
  if (!row) return null;

  let credentials: WhatsAppCloudCredentialsInput;
  try {
    credentials = decryptJson<WhatsAppCloudCredentialsInput>(row.credentials as string);
  } catch (error) {
    logger.error("WhatsApp Cloud API config could not be decrypted - treating as not configured", error instanceof Error ? error.message : error);
    return null;
  }

  const full: MetaCloudApiCredentials = {
    phoneNumberId: row.phoneNumberId,
    businessAccountId: row.businessAccountId,
    accessToken: credentials.accessToken,
    appSecret: credentials.appSecret,
    verifyToken: credentials.verifyToken,
    graphApiVersion: GRAPH_API_VERSION,
  };
  return new MetaCloudApiProvider(full);
}

/** Just the verify token, for the GET webhook handshake - null for "not configured"/"inactive"/
 *  "cannot be decrypted" alike, same contract as getMetaWhatsAppProvider(). Kept separate rather
 *  than exposing verifyToken on MetaCloudApiProvider's public surface for this one caller. */
export async function getActiveVerifyToken(db: DbClient = prisma): Promise<string | null> {
  const row = await db.whatsAppConfig.findFirst({ where: { isActive: true }, orderBy: { createdAt: "desc" }, select: { credentials: true } });
  if (!row) return null;
  try {
    return decryptJson<WhatsAppCloudCredentialsInput>(row.credentials as string).verifyToken;
  } catch (error) {
    logger.error("WhatsApp Cloud API config could not be decrypted", error instanceof Error ? error.message : error);
    return null;
  }
}
