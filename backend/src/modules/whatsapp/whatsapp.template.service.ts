import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import { getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { NormalizedTemplate, WhatsAppProvider } from "./whatsapp.provider.js";
import { extractTemplateVariables } from "./whatsapp.template.variables.js";
import type { CreateTemplateInput, ListTemplatesQuery, TemplateListResult, TemplateSummary, TemplateSyncSummary, UpdateTemplateInput } from "./whatsapp.template.types.js";

const TEMPLATE_SELECT = {
  id: true,
  name: true,
  provider: true,
  providerTemplateId: true,
  externalId: true,
  category: true,
  language: true,
  body: true,
  variables: true,
  status: true,
  quality: true,
  lastSyncedAt: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WhatsAppTemplateSelect;

type TemplateRow = Prisma.WhatsAppTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

function mapTemplate(row: TemplateRow): TemplateSummary {
  return { ...row, variables: Array.isArray(row.variables) ? (row.variables as string[]) : [] };
}

const REFERENCE_TYPE = "WhatsAppTemplate";

// SALESPERSON only ever sees usable, provider-approved templates - "view/use approved templates,
// no unsafe template administration" (E7.2 RBAC). ADMIN/MANAGER see every status, since managing
// drafts/rejections is their job. Templates have no owner/lead, so this is a plain role check, not
// getLeadScope - the same shape Users/Groups (also role-only, no lead scope) already use.
function visibleStatusesFor(role: Role): WhatsAppTemplateStatus[] | null {
  return role === Role.SALESPERSON ? [WhatsAppTemplateStatus.APPROVED] : null; // null = no restriction
}

class WhatsAppTemplateService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getProvider: () => WhatsAppProvider | null = getWhatsAppProvider,
    // Meta's provider is DB-config-backed (Settings -> WhatsApp Config); only used when a Meta sync is requested explicitly.
    private readonly getMeta?: () => Promise<WhatsAppProvider | null>,
  ) {}

  async listTemplates(user: AuthUser, query: ListTemplatesQuery): Promise<TemplateListResult> {
    const and: Prisma.WhatsAppTemplateWhereInput[] = [];
    const allowedStatuses = visibleStatusesFor(user.role);
    if (allowedStatuses) and.push({ status: { in: allowedStatuses } });
    if (query.status) {
      // A salesperson filtering by a status they cannot see gets an empty page, not an error or a
      // silently-widened result - the same "narrow, never leak" rule scope filters use elsewhere.
      // The nil UUID is syntactically valid (id is a `uuid` column) but never assigned by randomUUID().
      if (allowedStatuses && !allowedStatuses.includes(query.status)) and.push({ id: "00000000-0000-0000-0000-000000000000" });
      else and.push({ status: query.status });
    }
    if (query.provider) and.push({ provider: query.provider });
    if (query.category) and.push({ category: query.category });
    if (query.language) and.push({ language: query.language });
    if (query.search) and.push({ OR: [{ name: { contains: query.search, mode: "insensitive" } }, { body: { contains: query.search, mode: "insensitive" } }] });

    const where: Prisma.WhatsAppTemplateWhereInput = and.length > 0 ? { AND: and } : {};

    const [totalItems, rows] = await Promise.all([
      this.db.whatsAppTemplate.count({ where }),
      this.db.whatsAppTemplate.findMany({
        where,
        select: TEMPLATE_SELECT,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map(mapTemplate),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }

  async getTemplate(user: AuthUser, id: string): Promise<TemplateSummary> {
    const allowedStatuses = visibleStatusesFor(user.role);
    const where: Prisma.WhatsAppTemplateWhereInput = allowedStatuses ? { id, status: { in: allowedStatuses } } : { id };
    // Out of scope looks the same as missing, same convention as orders/customers - a salesperson
    // probing a draft/rejected template's id learns nothing.
    const row = await this.db.whatsAppTemplate.findFirst({ where, select: TEMPLATE_SELECT });
    if (!row) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
    return mapTemplate(row);
  }

  async createTemplate(user: AuthUser, input: CreateTemplateInput): Promise<TemplateSummary> {
    const { variables, errors } = extractTemplateVariables(input.body);
    if (errors.length > 0) throw new ApiError(errors[0], STATUS_CODES.BAD_REQUEST);

    let row: TemplateRow;
    try {
      row = await this.db.whatsAppTemplate.create({
        data: {
          name: input.name,
          provider: input.provider,
          category: input.category ?? null,
          language: input.language,
          body: input.body,
          variables,
          status: WhatsAppTemplateStatus.DRAFT,
          createdById: user.id,
        },
        select: TEMPLATE_SELECT,
      });
    } catch (error) {
      if (error instanceof Object && "code" in error && error.code === "P2002") {
        throw new ApiError("A template with this name and language already exists for this provider", STATUS_CODES.CONFLICT);
      }
      throw error;
    }

    await this.recordActivity(user, ActivityType.WHATSAPP_TEMPLATE_CREATED, row.id, "WhatsApp template created", row.name);
    return mapTemplate(row);
  }

  async updateTemplate(user: AuthUser, id: string, input: UpdateTemplateInput): Promise<TemplateSummary> {
    const existing = await this.db.whatsAppTemplate.findUnique({ where: { id }, select: { id: true, name: true, body: true, status: true } });
    if (!existing) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);

    const data: Prisma.WhatsAppTemplateUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.category !== undefined) data.category = input.category;
    if (input.language !== undefined) data.language = input.language;
    if (input.body !== undefined) {
      const { variables, errors } = extractTemplateVariables(input.body);
      if (errors.length > 0) throw new ApiError(errors[0], STATUS_CODES.BAD_REQUEST);
      data.body = input.body;
      data.variables = variables;
    }

    const statusChanging = input.status !== undefined && input.status !== existing.status;
    if (statusChanging) {
      // A provider's own review states are never set by hand - only a real sync (syncTemplates
      // below) may move a template to PENDING/APPROVED/REJECTED, so the CRM can never claim an
      // approval it did not actually see from the provider.
      data.status = input.status;
    }

    let row: TemplateRow;
    try {
      row = await this.db.whatsAppTemplate.update({ where: { id }, data, select: TEMPLATE_SELECT });
    } catch (error) {
      if (error instanceof Object && "code" in error && error.code === "P2002") {
        throw new ApiError("A template with this name and language already exists for this provider", STATUS_CODES.CONFLICT);
      }
      throw error;
    }

    await this.recordActivity(user, ActivityType.WHATSAPP_TEMPLATE_UPDATED, row.id, "WhatsApp template updated", row.name);
    if (statusChanging) {
      await this.recordActivity(user, ActivityType.WHATSAPP_TEMPLATE_STATUS_CHANGED, row.id, "WhatsApp template status changed", `${existing.status} -> ${row.status}`);
    }
    return mapTemplate(row);
  }

  /** Syncs templates from the legacy env-configured provider (unchanged), or - when `only` is "META" - from the active
   *  Meta WhatsApp Cloud API config. A synced Meta template is what makes it APPROVED and sendable. */
  async syncTemplates(user: AuthUser, only?: "META"): Promise<TemplateSyncSummary> {
    let provider: WhatsAppProvider | null;
    if (only === "META") {
      provider = this.getMeta ? await this.getMeta() : await getMetaWhatsAppProvider(this.db);
      if (!provider) throw new ApiError("Meta WhatsApp Cloud API is not configured (or its saved credentials cannot be decrypted). Check Settings → WhatsApp Config.", STATUS_CODES.SERVICE_UNAVAILABLE);
    } else {
      provider = this.getProvider();
      if (!provider) throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE);
    }

    let result;
    try {
      result = await provider.listTemplates();
    } catch (error) {
      throw error instanceof WhatsAppSendError ? new ApiError(error.message, STATUS_CODES.BAD_REQUEST) : error;
    }

    if (!result.supported) {
      return { provider: provider.id, supported: false, reason: result.reason, created: 0, updated: 0, unchanged: 0, total: 0 };
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const now = new Date();

    for (const t of result.templates) {
      const outcome = await this.upsertSyncedTemplate(provider.id, t, now);
      if (outcome === "created") created++;
      else if (outcome === "updated") updated++;
      else unchanged++;
    }

    const summary: TemplateSyncSummary = { provider: provider.id, supported: true, created, updated, unchanged, total: result.templates.length };
    await this.recordActivity(
      user,
      ActivityType.WHATSAPP_TEMPLATE_SYNCED,
      null,
      "WhatsApp templates synced",
      `${provider.id}: ${created} created, ${updated} updated, ${unchanged} unchanged`,
    );
    return summary;
  }

  private async upsertSyncedTemplate(provider: WhatsAppProvider["id"], t: NormalizedTemplate, syncedAt: Date): Promise<"created" | "updated" | "unchanged"> {
    const existing = await this.db.whatsAppTemplate.findUnique({
      where: { provider_providerTemplateId: { provider, providerTemplateId: t.providerTemplateId } },
      select: { id: true, name: true, category: true, language: true, body: true, status: true, quality: true, externalId: true },
    });

    const { variables } = extractTemplateVariables(t.body);
    const status = t.status === "UNKNOWN" ? WhatsAppTemplateStatus.DISABLED : (t.status as WhatsAppTemplateStatus);
    const data = { name: t.name, category: t.category, language: t.language, body: t.body, variables, status, quality: t.quality, externalId: t.externalId, lastSyncedAt: syncedAt };

    if (!existing) {
      await this.db.whatsAppTemplate.create({ data: { ...data, provider, providerTemplateId: t.providerTemplateId } });
      return "created";
    }

    const changed = existing.name !== t.name || existing.category !== t.category || existing.language !== t.language || existing.body !== t.body || existing.status !== status || existing.quality !== t.quality || existing.externalId !== t.externalId;
    await this.db.whatsAppTemplate.update({ where: { id: existing.id }, data });
    return changed ? "updated" : "unchanged";
  }

  private async recordActivity(user: AuthUser, type: ActivityType, referenceId: string | null, title: string, description: string | null): Promise<void> {
    await this.db.activity.create({
      data: { actorId: user.id, actorRole: user.role, type, referenceType: REFERENCE_TYPE, referenceId, source: ActivitySource.USER, title, description },
    });
  }
}

export default WhatsAppTemplateService;
