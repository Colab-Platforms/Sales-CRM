// Prisma implementation of the agency API's storage: keys (hash only), the request log, and the few CRM lookups it needs (customer by number, order by reference, consent, approved templates).
import { prisma } from "@/lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { AgencyRepo, AiAgentActivity, StoredRequest } from "./agency.payment-link.service.js";

const AI_AGENT_REFERENCE = "AgencyMessageRequest";

type Db = typeof prisma | Prisma.TransactionClient;

const toStored = (r: { id: string; status: string; requestHash: string; httpStatus: number | null; response: Prisma.JsonValue | null; createdAt: Date }): StoredRequest => ({ id: r.id, status: r.status, requestHash: r.requestHash, httpStatus: r.httpStatus, response: r.response, createdAt: r.createdAt });
const STORED_SELECT = { id: true, status: true, requestHash: true, httpStatus: true, response: true, createdAt: true } as const;

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
    const row = await this.db.agencyMessageRequest.findFirst({ where: { apiKeyId, requestHash: hash, status: { in: ["SENT", "RECORDED", "RECEIVED"] }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: STORED_SELECT });
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

  /**
   * The customer's orders that can be paid online instead of on delivery: COD (the order was placed as COD, or carries a COD payment), nothing paid yet, an amount still owed, and not cancelled / returned /
   * refunded / draft / already on its way to the customer (a shipped COD parcel is collected by the courier). A mobile number can belong to more than one lead record; all of them are searched.
   */
  async findEligibleCodOrders(mobile: string) {
    const leads = await this.db.lead.findMany({ where: { normalizedMobile: mobile }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    if (leads.length === 0) return { known: false, leadIds: [], orders: [] };
    const rows = await this.db.order.findMany({
      where: { leadId: { in: leads.map((l) => l.id) }, status: { in: ["CONFIRMED", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, leadId: true, orderNumber: true, externalNumber: true, totalAmount: true, metadata: true, payments: { select: { status: true, method: true, amount: true, refundedAmount: true } } },
    });
    const cents = (v: { toString(): string } | null) => Math.round(Number((v ?? 0).toString()) * 100);
    const orders = rows.flatMap((o) => {
      const mode = (o.metadata as { paymentMode?: unknown } | null)?.paymentMode;
      const isCod = mode === "COD" || (mode !== "PREPAID" && o.payments.some((p) => p.method === "COD"));
      if (!isCod) return [];
      if (o.payments.some((p) => p.status === "SUCCESS")) return []; // something is already paid: not a plain COD order any more
      const owed = cents(o.totalAmount);
      if (owed <= 0) return [];
      return [{ id: o.id, leadId: o.leadId, orderNumber: o.orderNumber, shopifyOrderNumber: o.externalNumber, amount: (owed / 100).toFixed(2) }];
    });
    return { known: true, leadIds: leads.map((l) => l.id), orders };
  }

  async findLeadIdsByMobile(mobile: string): Promise<string[]> {
    const leads = await this.db.lead.findMany({ where: { normalizedMobile: mobile }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    return leads.map((l) => l.id);
  }

  /**
   * One AI Agent activity per request, keyed by the request id: a failed request retried with the same Idempotency-Key updates its row instead of adding a second one. Only an Activity row is written - the lead
   * itself (status, owner, assignment, last contacted, calls) is never touched, so a request is never mistaken for a call or for a telecaller's work.
   */
  async recordAiAgentActivity(row: AiAgentActivity): Promise<void> {
    const sent = row.result === "PAYMENT_LINK_SENT";
    const title =
      row.intent === "ALREADY_ORDERED" && row.method === "PREPAID"
        ? "AI Agent: already ordered (prepaid) - recorded, no payment link sent"
        : row.intent === "INTERESTED"
        ? row.leadId ? "AI Agent: customer interested (no payment link sent)" : "AI Agent: interested customer - no matching lead"
        : sent ? "AI Agent: payment link sent on WhatsApp" : `AI Agent: payment link request - ${row.result.replace(/_/g, " ").toLowerCase()}`;
    const data = {
      leadId: row.leadId,
      orderId: row.orderId,
      title,
      description: `${row.customerName} (${row.normalizedMobile}) - ${row.intent}${row.method ? ` / ${row.method}` : ""} - ${row.result}`,
      metadata: {
        aiAgent: true,
        intent: row.intent,
        method: row.method,
        requestId: row.requestId,
        idempotencyKey: row.idempotencyKey,
        customerName: row.customerName,
        normalizedMobile: row.normalizedMobile,
        result: row.result,
        httpStatus: row.httpStatus,
        apiKey: row.apiKeyName,
        // The request reached the CRM; this is NOT a call outcome. Only outcomes the agency itself supplies may ever be recorded as one.
        callOutcome: null,
      } satisfies Prisma.InputJsonObject,
    };
    const existing = await this.db.activity.findFirst({ where: { type: "AI_AGENT_PAYMENT_LINK_REQUEST", referenceType: AI_AGENT_REFERENCE, referenceId: row.requestId }, select: { id: true } });
    if (existing) await this.db.activity.update({ where: { id: existing.id }, data });
    else await this.db.activity.create({ data: { ...data, type: "AI_AGENT_PAYMENT_LINK_REQUEST", source: "AI_AGENT", actorId: null, actorRole: null, referenceType: AI_AGENT_REFERENCE, referenceId: row.requestId, createdAt: row.at } });
  }

  async getConsent(leadId: string): Promise<"OPTED_IN" | "OPTED_OUT" | "UNKNOWN"> {
    const row = await this.db.communicationPreference.findUnique({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } }, select: { status: true } });
    return row?.status === "OPTED_IN" || row?.status === "OPTED_OUT" ? row.status : "UNKNOWN";
  }

  countSentToLead(leadId: string, since: Date) {
    return this.db.agencyMessageRequest.count({ where: { leadId, status: "SENT", createdAt: { gte: since } } });
  }

  async approvedPaymentLinkTemplates() {
    const rows = await this.db.whatsAppTemplate.findMany({ where: { provider: "META", status: "APPROVED" }, select: { id: true, name: true, variables: true, providerTemplateId: true }, orderBy: { name: "asc" } });
    return rows.filter((t) => Boolean(t.providerTemplateId) && Array.isArray(t.variables) && (t.variables as string[]).includes("payment_link")).map((t) => ({ id: t.id, name: t.name }));
  }
}
