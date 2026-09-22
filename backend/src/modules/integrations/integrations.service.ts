import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { encryptJson, decryptJson } from "@/utils/crypto.js";
import { logger } from "@/utils/logger.js";
import LeadService from "../lead/lead.service.js";
import { getAdapter } from "./adapters/registry.js";
import type { DecryptedCredentials, WebhookHeaders } from "./adapters/adapter.types.js";
import { SourceStatus, SourceType, WebhookStatus } from "../../../generated/prisma/enums.js";
import type { Prisma, Source } from "../../../generated/prisma/client.js";
import type {
  CreateSourceBody,
  UpdateSourceBody,
  ListSourcesQuery,
  ToggleSourceStatusBody,
} from "./integrations.types.js";

const leadService = new LeadService();

function toPublicSource(source: Source) {
  const { credentials: _credentials, ...rest } = source;
  return { ...rest, hasCredentials: Boolean(_credentials) };
}

class IntegrationsService {
  async listSources(query: ListSourcesQuery) {
    const sources = await prisma.source.findMany({
      where: {
        ...(query.type ? { type: query.type as SourceType } : {}),
        ...(query.status ? { status: query.status as SourceStatus } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return sources.map(toPublicSource);
  }

  private async getSourceOrThrow(id: string) {
    const source = await prisma.source.findUnique({ where: { id } });
    if (!source) throw new ApiError("Source not found", STATUS_CODES.NOT_FOUND);
    return source;
  }

  async getSource(id: string) {
    return toPublicSource(await this.getSourceOrThrow(id));
  }

  async createSource(data: CreateSourceBody) {
    const source = await prisma.source.create({
      data: {
        name: data.name,
        type: data.type as SourceType,
        description: data.description,
        externalAccountId: data.externalAccountId,
        config: data.config as Prisma.InputJsonValue | undefined,
        credentials: data.credentials ? encryptJson(data.credentials) : undefined,
      },
    });
    return toPublicSource(source);
  }

  async updateSource(id: string, data: UpdateSourceBody) {
    await this.getSourceOrThrow(id);
    const source = await prisma.source.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        externalAccountId: data.externalAccountId,
        config: data.config as Prisma.InputJsonValue | undefined,
        ...(data.credentials ? { credentials: encryptJson(data.credentials) } : {}),
      },
    });
    return toPublicSource(source);
  }

  async toggleStatus(id: string, data: ToggleSourceStatusBody) {
    await this.getSourceOrThrow(id);
    const source = await prisma.source.update({
      where: { id },
      data: { status: data.status as SourceStatus },
    });
    return toPublicSource(source);
  }

  async listSourceEvents(id: string, limit: number) {
    await this.getSourceOrThrow(id);
    return prisma.webhookEvent.findMany({
      where: { sourceId: id },
      orderBy: { receivedAt: "desc" },
      take: limit,
    });
  }

  verifyMetaChallenge(query: Record<string, unknown>): string {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode !== "subscribe" || !challenge || token !== process.env.META_WEBHOOK_VERIFY_TOKEN) {
      throw new ApiError("Verification failed", STATUS_CODES.FORBIDDEN);
    }
    return String(challenge);
  }

  async handleWebhook(provider: string, headers: WebhookHeaders, rawBody: string, parsedBody: unknown): Promise<void> {
    const adapter = getAdapter(provider);

    const externalAccountId = adapter.resolveExternalAccountId(parsedBody, headers);
    const eventType = adapter.resolveEventType(parsedBody, headers);
    const source = externalAccountId
      ? await prisma.source.findFirst({
          where: { type: adapter.provider, externalAccountId, status: SourceStatus.ACTIVE },
        })
      : null;

    logger.info(
      `[webhook] resolved account=${externalAccountId ?? "-"} event=${eventType} source=${source ? source.name : "NONE"}`,
    );

    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        provider: provider.toLowerCase(),
        eventType,
        payload: parsedBody as object,
        status: WebhookStatus.RECEIVED,
        sourceId: source?.id,
        receivedAt: new Date(),
      },
    });

    if (!source) {
      logger.warn(
        `[webhook] no active ${adapter.provider} Source with externalAccountId=${externalAccountId ?? "-"} — ignoring`,
      );
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookStatus.IGNORED, errorMessage: "No matching active Source found", processedAt: new Date() },
      });
      return;
    }

    const credentials = source.credentials ? decryptJson<DecryptedCredentials>(source.credentials as string) : {};

    if (!adapter.verifySignature(rawBody, headers, credentials)) {
      logger.warn(`[webhook] signature verification FAILED for source=${source.name}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookStatus.FAILED, errorMessage: "Signature verification failed", processedAt: new Date() },
      });
      throw new ApiError("Invalid signature", STATUS_CODES.UNAUTHORIZED);
    }

    try {
      const entries = adapter.parseWebhookPayload(parsedBody);
      let created = 0;
      const errors: string[] = [];

      for (const entry of entries) {
        try {
          const enriched = adapter.fetchAdditionalData ? await adapter.fetchAdditionalData(entry, credentials) : entry;
          const mapped = adapter.mapToLeadData(enriched, (source.config as Record<string, unknown>) ?? null);
          if (!mapped) {
            logger.warn(`[webhook] entry skipped — no usable lead fields in payload`);
            continue;
          }

          const lead = await leadService.createLeadFromSource(
            source.id,
            mapped,
            `Lead created via ${source.name} integration`,
          );
          logger.info(`[webhook] lead created ${lead.leadNumber} (${mapped.firstName})`);
          created += 1;
        } catch (entryError: any) {
          logger.error(`[webhook] entry processing failed`, entryError);
          errors.push(entryError.message ?? "Unknown error processing entry");
        }
      }

      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: errors.length && created === 0 ? WebhookStatus.FAILED : WebhookStatus.PROCESSED,
          errorMessage: errors.length ? errors.join("; ") : undefined,
          processedAt: new Date(),
        },
      });

      await prisma.source.update({
        where: { id: source.id },
        data: {
          lastSyncedAt: new Date(),
          lastSyncStatus: errors.length && created === 0 ? "ERROR" : "OK",
          lastSyncError: errors.length ? errors.join("; ") : null,
        },
      });
    } catch (error: any) {
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookStatus.FAILED, errorMessage: error.message ?? "Unknown error", processedAt: new Date() },
      });
      await prisma.source.update({
        where: { id: source.id },
        data: { lastSyncedAt: new Date(), lastSyncStatus: "ERROR", lastSyncError: error.message ?? "Unknown error" },
      });
    }
  }
}

export default IntegrationsService;
