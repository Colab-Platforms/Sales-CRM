// Prisma implementation of the agency API's storage: keys (hash only), the request log, and the few CRM lookups it needs (customer by number, order by reference, consent, approved templates).
import { prisma } from "@/lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { generateLeadNumber } from "@/utils/leadNumber.js";
import type { AgencyRepo, StoredRequest } from "./agency.payment-link.service.js";

type Db = typeof prisma | Prisma.TransactionClient;

const toStored = (r: { id: string; status: string; requestHash: string; httpStatus: number | null; response: Prisma.JsonValue | null; createdAt: Date }): StoredRequest => ({ id: r.id, status: r.status, requestHash: r.requestHash, httpStatus: r.httpStatus, response: r.response, createdAt: r.createdAt });
const STORED_SELECT = { id: true, status: true, requestHash: true, httpStatus: true, response: true, createdAt: true } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrismaAgencyRepo implements AgencyRepo {
  constructor(private readonly db: Db = prisma) {}

  findKeyByHash(hash: string) {
    return this.db.agencyApiKey.findUnique({ where: { keyHash: hash }, select: { id: true, name: true, isActive: true, revokedAt: true, rateLimitPerMinute: true } });
  }

  async touchKey(id: string, at: Date): Promise<void> {
    // At most one write a minute per key: authentication must not turn every request into a database write.
    await this.db.agencyApiKey.updateMany({ where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(at.getTime() - 60_000) } }] }, data: { lastUsedAt: at } });
  }

  async claim(row: Parameters<AgencyRepo["claim"]>[0]) {
    const { count } = await this.db.agencyMessageRequest.createMany({
      data: [{ id: row.id, apiKeyId: row.apiKeyId, idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, status: "RECEIVED", customerName: row.customerName.slice(0, 200), toMasked: row.toMasked, linkHost: row.linkHost.slice(0, 255), orderRef: row.orderRef, sourceIp: row.sourceIp?.slice(0, 64) ?? null }],
      skipDuplicates: true,
    });
    if (count === 1) return { created: true, existing: null };
    const existing = await this.db.agencyMessageRequest.findUnique({ where: { apiKeyId_idempotencyKey: { apiKeyId: row.apiKeyId, idempotencyKey: row.idempotencyKey } }, select: STORED_SELECT });
    return { created: false, existing: existing ? toStored(existing) : null };
  }

  async reclaimFailed(id: string): Promise<boolean> {
    const { count } = await this.db.agencyMessageRequest.updateMany({ where: { id, status: "FAILED" }, data: { status: "RECEIVED", completedAt: null } });
    return count === 1;
  }

  async findRecentSameRequest(apiKeyId: string, hash: string, since: Date) {
    const row = await this.db.agencyMessageRequest.findFirst({ where: { apiKeyId, requestHash: hash, status: { in: ["SENT", "RECEIVED"] }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: STORED_SELECT });
    return row ? toStored(row) : null;
  }

  async complete(id: string, patch: Parameters<AgencyRepo["complete"]>[1], at: Date): Promise<void> {
    await this.db.agencyMessageRequest.update({
      where: { id },
      data: {
        status: patch.status,
        httpStatus: patch.httpStatus,
        response: patch.response as Prisma.InputJsonValue,
        errorCode: patch.errorCode ?? null,
        errorMessage: patch.errorMessage ?? null,
        leadId: patch.leadId ?? null,
        orderId: patch.orderId ?? null,
        messageId: patch.messageId ?? null,
        providerMessageId: patch.providerMessageId ?? null,
        templateName: patch.templateName ?? null,
        completedAt: at,
      },
    });
  }

  async logRejected(row: Parameters<AgencyRepo["logRejected"]>[0], at: Date): Promise<void> {
    await this.db.agencyMessageRequest.create({
      data: { id: row.id, apiKeyId: row.apiKeyId, idempotencyKey: `rejected:${row.id}`, requestHash: "", status: "REJECTED", customerName: row.customerName, toMasked: "-", linkHost: "-", httpStatus: row.httpStatus, errorCode: row.errorCode, errorMessage: row.errorMessage, response: row.response as Prisma.InputJsonValue, sourceIp: row.sourceIp?.slice(0, 64) ?? null, completedAt: at },
    });
  }

  findLeadByMobile(mobile: string) {
    return this.db.lead.findFirst({ where: { normalizedMobile: mobile }, orderBy: { createdAt: "asc" }, select: { id: true, normalizedMobile: true } });
  }

  async createLead(input: { customerName: string; mobile: string }) {
    const [first, ...rest] = input.customerName.split(" ");
    return this.db.lead.create({
      data: { leadNumber: generateLeadNumber(), firstName: (first ?? input.customerName).slice(0, 100), lastName: rest.length ? rest.join(" ").slice(0, 100) : null, mobile: input.mobile, normalizedMobile: input.mobile, requirement: "Created by the AI calling agency payment-link request" },
      select: { id: true },
    });
  }

  async findOrder(ref: string) {
    const clean = ref.replace(/^#/, "");
    const row = await this.db.order.findFirst({
      where: { OR: [{ orderNumber: clean }, { externalNumber: clean }, { externalNumber: `#${clean}` }, ...(UUID.test(clean) ? [{ id: clean }] : [])] },
      orderBy: { createdAt: "desc" },
      select: { id: true, leadId: true, lead: { select: { normalizedMobile: true } } },
    });
    return row ? { id: row.id, leadId: row.leadId, leadMobile: row.lead.normalizedMobile } : null;
  }

  async recordConsent(leadId: string, at: Date): Promise<"OPTED_IN" | "OPTED_OUT"> {
    const existing = await this.db.communicationPreference.findUnique({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, select: { status: true } });
    if (existing?.status === "OPTED_OUT") return "OPTED_OUT";
    if (existing?.status === "OPTED_IN") return "OPTED_IN";
    await this.db.communicationPreference.upsert({
      where: { leadId_channel: { leadId, channel: "WHATSAPP" } },
      create: { leadId, channel: "WHATSAPP", status: "OPTED_IN", source: "AI_CALLING_AGENCY", consentAt: at },
      update: { status: "OPTED_IN", source: "AI_CALLING_AGENCY", consentAt: at },
    });
    return "OPTED_IN";
  }

  countSentToLead(leadId: string, since: Date) {
    return this.db.agencyMessageRequest.count({ where: { leadId, status: "SENT", createdAt: { gte: since } } });
  }

  async approvedPaymentLinkTemplates() {
    const rows = await this.db.whatsAppTemplate.findMany({ where: { provider: "META", status: "APPROVED" }, select: { id: true, name: true, variables: true, providerTemplateId: true }, orderBy: { name: "asc" } });
    return rows.filter((t) => Boolean(t.providerTemplateId) && Array.isArray(t.variables) && (t.variables as string[]).includes("payment_link")).map((t) => ({ id: t.id, name: t.name }));
  }
}
