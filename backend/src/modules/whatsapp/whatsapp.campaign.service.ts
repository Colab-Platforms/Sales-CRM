import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "../customers/customers.service.js";
import type { CustomerListItem } from "../customers/customers.types.js";
import type {
  AudienceFilters,
  AudiencePreview,
  CampaignDetail,
  CampaignListResult,
  CampaignRecipientListResult,
  CampaignStats,
  CampaignSummary,
  CreateCampaignInput,
  LaunchCampaignInput,
  ListCampaignRecipientsQuery,
  ListCampaignsQuery,
  UpdateCampaignInput,
} from "./whatsapp.campaign.types.js";

// E7.7 Campaign & Bulk Messaging.
//
// Audience resolution reuses CustomersService.resolveMatchingCustomers verbatim (E6.7's own
// segmentation, scope and filters) - never a second engine. The actual send path reuses
// WhatsAppMessagingService.sendTemplateAsSystem (the same method E7.6's automations use) - never
// calls a provider directly. This file's own job is strictly: campaign CRUD, audience preview,
// launch-time recipient creation, and campaign/recipient stats - the batch-processing worker lives
// in whatsapp.campaign.scheduler.ts, since it is triggered by the same interval-based background
// job convention E7.1/E7.6 already established, not by an HTTP request.

const REFERENCE_TYPE = "WhatsAppCampaign";
const PREVIEW_SAMPLE_SIZE = 5;

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  template: { select: { id: true, name: true, status: true } },
  createdBy: { select: { id: true, name: true } },
  scheduledAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WhatsAppCampaignSelect;

type CampaignRow = Prisma.WhatsAppCampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

// The actual send (WhatsAppMessagingService.sendTemplateAsSystem) is only ever invoked from
// whatsapp.campaign.scheduler.ts's batch worker, never from this service - creating recipients here
// and sending them there is exactly what keeps a launch a fast, synchronous HTTP response instead
// of a request that blocks on hundreds of provider calls.
class WhatsAppCampaignService {
  private readonly customers: CustomersService;

  constructor(
    private readonly db: DbClient = prisma,
    customers?: CustomersService,
  ) {
    // Defaults to a service bound to this SAME db client, so a test running inside one rolled-back
    // transaction never has a sibling service silently writing outside it.
    this.customers = customers ?? new CustomersService(db);
  }

  /** Every matching customer within the caller's RBAC scope, split by whether they have a mobile number on file. */
  async resolveAudience(user: AuthUser, filters: AudienceFilters): Promise<{ matched: CustomerListItem[]; excludedNoMobile: number }> {
    const all = await this.customers.resolveMatchingCustomers(user, filters);
    const matched = all.filter((c) => c.mobile !== null && c.mobile.trim() !== "");
    return { matched, excludedNoMobile: all.length - matched.length };
  }

  async previewAudience(user: AuthUser, filters: AudienceFilters): Promise<AudiencePreview> {
    const { matched, excludedNoMobile } = await this.resolveAudience(user, filters);
    return { count: matched.length, sample: matched.slice(0, PREVIEW_SAMPLE_SIZE), excludedNoMobile };
  }

  async createCampaign(user: AuthUser, input: CreateCampaignInput): Promise<CampaignDetail> {
    await this.assertTemplateApproved(input.templateId);

    const row = await this.db.whatsAppCampaign.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        templateId: input.templateId,
        filters: input.filters as Prisma.InputJsonValue,
        createdById: user.id,
      },
      select: CAMPAIGN_SELECT,
    });

    await this.writeActivity(user, ActivityType.WHATSAPP_CAMPAIGN_CREATED, row.id, `Campaign "${row.name}" created`);
    return this.toDetail(row, input.filters);
  }

  async updateCampaign(user: AuthUser, id: string, input: UpdateCampaignInput): Promise<CampaignDetail> {
    void user; // no Activity for a DRAFT edit - only the lifecycle events section 18 actually asks for
    const existing = await this.db.whatsAppCampaign.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) throw new ApiError("Campaign not found", STATUS_CODES.NOT_FOUND);
    if (existing.status !== "DRAFT") throw new ApiError(`Only a DRAFT campaign can be edited (this one is ${existing.status}).`, STATUS_CODES.BAD_REQUEST);
    if (input.templateId) await this.assertTemplateApproved(input.templateId);

    const row = await this.db.whatsAppCampaign.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        ...(input.filters !== undefined ? { filters: input.filters as Prisma.InputJsonValue } : {}),
      },
      select: CAMPAIGN_SELECT,
    });

    const filters = await this.filtersOf(id);
    return this.toDetail(row, filters);
  }

  async getCampaign(user: AuthUser, id: string): Promise<CampaignDetail> {
    void user; // campaign visibility itself is route-level (ADMIN/MANAGER) - see whatsapp.campaign.routes wiring
    const row = await this.db.whatsAppCampaign.findUnique({ where: { id }, select: { ...CAMPAIGN_SELECT, filters: true } });
    if (!row) throw new ApiError("Campaign not found", STATUS_CODES.NOT_FOUND);
    return this.toDetail(row, row.filters as AudienceFilters);
  }

  async listCampaigns(user: AuthUser, query: ListCampaignsQuery): Promise<CampaignListResult> {
    void user;
    const where: Prisma.WhatsAppCampaignWhereInput = query.status ? { status: query.status } : {};
    const [totalItems, rows] = await Promise.all([
      this.db.whatsAppCampaign.count({ where }),
      this.db.whatsAppCampaign.findMany({
        where,
        select: CAMPAIGN_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const items = await Promise.all(rows.map((row) => this.toSummary(row)));
    return { items, pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) } };
  }

  async listRecipients(user: AuthUser, campaignId: string, query: ListCampaignRecipientsQuery): Promise<CampaignRecipientListResult> {
    const campaign = await this.db.whatsAppCampaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!campaign) throw new ApiError("Campaign not found", STATUS_CODES.NOT_FOUND);

    const leadScope = await getLeadScope(user, this.db);
    const where: Prisma.WhatsAppCampaignRecipientWhereInput = {
      campaignId,
      ...(query.status ? { status: query.status } : {}),
      ...(Object.keys(leadScope).length > 0 ? { lead: leadScope } : {}),
    };

    const [totalItems, rows] = await Promise.all([
      this.db.whatsAppCampaignRecipient.count({ where }),
      this.db.whatsAppCampaignRecipient.findMany({
        where,
        select: {
          id: true,
          status: true,
          failureReason: true,
          attemptedAt: true,
          lead: { select: { id: true, firstName: true, lastName: true, mobile: true } },
          whatsAppMessage: { select: { id: true, status: true, body: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true, errorMessage: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        customer: { leadId: r.lead.id, name: [r.lead.firstName, r.lead.lastName].filter(Boolean).join(" "), mobile: r.lead.mobile },
        status: r.status,
        failureReason: r.failureReason,
        attemptedAt: r.attemptedAt?.toISOString() ?? null,
        message: r.whatsAppMessage
          ? {
              id: r.whatsAppMessage.id,
              status: r.whatsAppMessage.status,
              body: r.whatsAppMessage.body,
              sentAt: r.whatsAppMessage.sentAt?.toISOString() ?? null,
              deliveredAt: r.whatsAppMessage.deliveredAt?.toISOString() ?? null,
              readAt: r.whatsAppMessage.readAt?.toISOString() ?? null,
              failedAt: r.whatsAppMessage.failedAt?.toISOString() ?? null,
              errorMessage: r.whatsAppMessage.errorMessage,
            }
          : null,
      })),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }

  /**
   * DRAFT -> RUNNING (or SCHEDULED for a future scheduledAt). Validates the template is still
   * APPROVED and the audience is non-empty BEFORE changing anything - a rejected launch leaves the
   * campaign untouched in DRAFT so it can be fixed and retried (never a dead FAILED campaign for
   * something this trivially correctable). The DRAFT->status transition itself is the atomic,
   * database-enforced guard against a double-launch; recipient creation is a idempotent bulk insert
   * on top of that, protected again by the campaignId+leadId unique constraint.
   */
  async launchCampaign(user: AuthUser, id: string, input: LaunchCampaignInput): Promise<CampaignDetail> {
    const campaign = await this.db.whatsAppCampaign.findUnique({ where: { id }, select: { id: true, name: true, status: true, templateId: true, filters: true } });
    if (!campaign) throw new ApiError("Campaign not found", STATUS_CODES.NOT_FOUND);
    if (campaign.status !== "DRAFT") throw new ApiError(`Only a DRAFT campaign can be launched (this one is ${campaign.status}).`, STATUS_CODES.BAD_REQUEST);

    await this.assertTemplateApproved(campaign.templateId);

    const filters = campaign.filters as AudienceFilters;
    const { matched, excludedNoMobile } = await this.resolveAudience(user, filters);
    if (matched.length === 0) {
      throw new ApiError(
        `No eligible recipients match this campaign's filters${excludedNoMobile > 0 ? ` (${excludedNoMobile} matched but have no WhatsApp/mobile number on file)` : ""}.`,
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const leadIds = matched.map((m) => m.leadId);
    const latestOrders = await this.db.order.findMany({
      where: { leadId: { in: leadIds } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["leadId"],
      select: { id: true, leadId: true },
    });
    const latestOrderByLead = new Map(latestOrders.map((o) => [o.leadId, o.id]));

    const scheduledAt = input.scheduledAt && input.scheduledAt.getTime() > Date.now() ? input.scheduledAt : null;
    const nextStatus = scheduledAt ? "SCHEDULED" : "RUNNING";

    const claim = await this.db.whatsAppCampaign.updateMany({
      where: { id, status: "DRAFT" },
      data: { status: nextStatus, scheduledAt, startedAt: scheduledAt ? null : new Date(), recipientCount: matched.length },
    });
    if (claim.count === 0) throw new ApiError("This campaign was already launched.", STATUS_CODES.CONFLICT);

    await this.db.whatsAppCampaignRecipient.createMany({
      data: matched.map((m) => ({ campaignId: id, leadId: m.leadId, orderId: latestOrderByLead.get(m.leadId) ?? null, status: "PENDING" as const })),
      skipDuplicates: true,
    });

    await this.writeActivity(
      user,
      ActivityType.WHATSAPP_CAMPAIGN_LAUNCHED,
      id,
      scheduledAt ? `Campaign "${campaign.name}" scheduled for ${scheduledAt.toISOString()} (${matched.length} recipients)` : `Campaign "${campaign.name}" launched (${matched.length} recipients)`,
    );

    return this.getCampaign(user, id);
  }

  /**
   * DRAFT/SCHEDULED/RUNNING -> CANCELLED. Every recipient still PENDING is marked SKIPPED (never
   * sent) - a message already SENT/dispatched is never touched or "un-sent", exactly per the
   * spec's "stop unclaimed future recipients, do not cancel messages already sent".
   */
  async cancelCampaign(user: AuthUser, id: string): Promise<CampaignDetail> {
    const campaign = await this.db.whatsAppCampaign.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
    if (!campaign) throw new ApiError("Campaign not found", STATUS_CODES.NOT_FOUND);
    if (campaign.status === "COMPLETED" || campaign.status === "CANCELLED" || campaign.status === "FAILED") {
      throw new ApiError(`A ${campaign.status} campaign cannot be cancelled.`, STATUS_CODES.BAD_REQUEST);
    }

    const claim = await this.db.whatsAppCampaign.updateMany({
      where: { id, status: { in: ["DRAFT", "SCHEDULED", "RUNNING"] } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    if (claim.count === 0) throw new ApiError("This campaign could not be cancelled (its status just changed).", STATUS_CODES.CONFLICT);

    await this.db.whatsAppCampaignRecipient.updateMany({
      where: { campaignId: id, status: "PENDING" },
      data: { status: "SKIPPED", failureReason: "Campaign was cancelled." },
    });

    await this.writeActivity(user, ActivityType.WHATSAPP_CAMPAIGN_CANCELLED, id, `Campaign "${campaign.name}" cancelled`);
    return this.getCampaign(user, id);
  }

  private async assertTemplateApproved(templateId: string): Promise<void> {
    const template = await this.db.whatsAppTemplate.findUnique({ where: { id: templateId }, select: { status: true } });
    if (!template) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
    if (template.status !== "APPROVED") throw new ApiError(`This template is ${template.status}, not APPROVED, and cannot be used for a campaign.`, STATUS_CODES.BAD_REQUEST);
  }

  private async filtersOf(id: string): Promise<AudienceFilters> {
    const row = await this.db.whatsAppCampaign.findUniqueOrThrow({ where: { id }, select: { filters: true } });
    return row.filters as AudienceFilters;
  }

  private async stats(campaignId: string): Promise<CampaignStats> {
    const [totalRecipients, pending, skipped, recipientFailed, delivered, read, sentOrQueued, messageFailed] = await Promise.all([
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, status: { in: ["PENDING", "CLAIMED"] } } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, status: "SKIPPED" } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, status: "FAILED" } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, whatsAppMessage: { status: "DELIVERED" } } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, whatsAppMessage: { status: "READ" } } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, whatsAppMessage: { status: { in: ["SENT", "QUEUED"] } } } }),
      this.db.whatsAppCampaignRecipient.count({ where: { campaignId, whatsAppMessage: { status: "FAILED" } } }),
    ]);

    return { totalRecipients, pending, sent: sentOrQueued, delivered, read, failed: recipientFailed + messageFailed, skipped };
  }

  private async toSummary(row: CampaignRow): Promise<CampaignSummary> {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      template: row.template,
      createdBy: row.createdBy,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      stats: await this.stats(row.id),
    };
  }

  private async toDetail(row: CampaignRow, filters: AudienceFilters): Promise<CampaignDetail> {
    const summary = await this.toSummary(row);
    return { ...summary, filters };
  }

  private async writeActivity(user: AuthUser, type: ActivityType, campaignId: string, title: string): Promise<void> {
    await this.db.activity.create({
      data: { actorId: user.id, actorRole: user.role, type, referenceType: REFERENCE_TYPE, referenceId: campaignId, source: ActivitySource.USER, title },
    });
  }
}

export default WhatsAppCampaignService;
