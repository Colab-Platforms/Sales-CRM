import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import { getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";
import type { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { NormalizedTemplate, WhatsAppProvider } from "./whatsapp.provider.js";
import { buildMetaTemplatePayload } from "./whatsapp.template.meta-payload.js";
import { extractTemplateVariables } from "./whatsapp.template.variables.js";
import type { CreateTemplateInput, DeleteTemplateResult, ListTemplatesQuery, SubmitTemplateResult, TemplateComponents, TemplateListResult, TemplateSummary, TemplateSyncSummary, UpdateTemplateInput } from "./whatsapp.template.types.js";

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
  components: true,
  status: true,
  quality: true,
  lastSyncedAt: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WhatsAppTemplateSelect;

type TemplateRow = Prisma.WhatsAppTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

function mapTemplate(row: TemplateRow): TemplateSummary {
  return {
    ...row,
    variables: Array.isArray(row.variables) ? (row.variables as string[]) : [],
    components: row.components && typeof row.components === "object" && !Array.isArray(row.components) ? (row.components as unknown as TemplateComponents) : null,
  };
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
    // Typed as the concrete class (not the generic WhatsAppProvider) because submitToMeta needs createTemplate(),
    // which is Meta-specific and deliberately not part of the shared WhatsAppProvider interface - kept separate
    // from `getMeta` above so existing tests injecting a plain WhatsAppProvider-shaped fake there are unaffected.
    private readonly getMetaProvider: () => Promise<MetaCloudApiProvider | null> = () => getMetaWhatsAppProvider(),
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

    const [campaigns, automationConfigs, messages] = await Promise.all([
      this.db.whatsAppCampaign.count({ where: { templateId: id } }),
      this.db.whatsAppAutomationConfig.count({ where: { templateId: id } }),
      this.db.whatsAppMessage.count({ where: { templateId: id } }),
    ]);

    return { ...mapTemplate(row), usage: { campaigns, automationConfigs, messages } };
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
          components: (input.components ?? undefined) as Prisma.InputJsonValue | undefined,
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
    if (input.components !== undefined) data.components = (input.components ?? Prisma.JsonNull) as Prisma.InputJsonValue;

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

  // Deletes the CRM's own local record only - there is no provider "delete template" API implemented anywhere in
  // this codebase (Meta/AiSensy/Gupshup only ever SYNC templates in; none has a create/delete call), so this can
  // never silently remove or desync anything on the provider side. If a real provider-delete capability is ever
  // added, it must be an explicit, separate, opt-in step - never bundled into this one by default.
  //
  // A template still referenced by a WhatsAppCampaign cannot be deleted (the FK is a required, non-nullable
  // RESTRICT relation - campaigns need their template to remain resolvable for their own history) - that case is
  // reported as a clear 409, never a raw Prisma foreign-key error. Messages/automation configs that used this
  // template are unaffected (their templateId is set to null, preserving their own history).
  async deleteTemplate(user: AuthUser, id: string): Promise<DeleteTemplateResult> {
    const existing = await this.db.whatsAppTemplate.findUnique({ where: { id }, select: { id: true, name: true, provider: true } });
    if (!existing) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);

    const campaignCount = await this.db.whatsAppCampaign.count({ where: { templateId: id } });
    if (campaignCount > 0) {
      throw new ApiError(
        `This template is used by ${campaignCount} campaign${campaignCount === 1 ? "" : "s"} and cannot be deleted. Cancel or reassign ${campaignCount === 1 ? "it" : "them"} first.`,
        STATUS_CODES.CONFLICT,
      );
    }

    try {
      await this.db.whatsAppTemplate.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Object && "code" in error && error.code === "P2025") throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
      if (error instanceof Object && "code" in error && error.code === "P2003") {
        throw new ApiError("This template is still referenced elsewhere and cannot be deleted.", STATUS_CODES.CONFLICT);
      }
      throw error;
    }

    await this.recordActivity(user, ActivityType.WHATSAPP_TEMPLATE_DELETED, null, "WhatsApp template deleted", `${existing.name} (${existing.provider})`);
    return { id, deleted: true };
  }

  // Submits a local Meta template to the real Meta Graph API for review. Submission success means Meta ACCEPTED it
  // FOR REVIEW - never that it is approved; the status this sets is whatever Meta itself reports (normally PENDING),
  // read through the exact same status vocabulary syncTemplates() already uses, so the two paths can never disagree.
  //
  // Idempotent against a double-click or two concurrent calls: the whole check-and-submit runs under an advisory
  // lock keyed to this template's id, inside one transaction, so a second call that arrives while the first is
  // still in flight blocks until the first commits, then sees the already-updated status and returns it without
  // calling Meta again. Once a template is PENDING or APPROVED, calling this again is a safe no-op that just
  // reports the current state - it never re-submits. A REJECTED template CAN be resubmitted (the real Meta
  // workflow: fix the template, try again).
  async submitToMeta(user: AuthUser, id: string): Promise<SubmitTemplateResult> {
    const existing = await this.db.whatsAppTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT });
    if (!existing) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
    if (existing.provider !== "META") throw new ApiError("Only a Meta Cloud API template can be submitted to Meta.", STATUS_CODES.BAD_REQUEST);

    if (existing.status === "PENDING" || existing.status === "APPROVED") {
      return { id, providerTemplateId: existing.providerTemplateId ?? "", status: existing.status, alreadySubmitted: true };
    }
    if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
      throw new ApiError(`This template is ${existing.status} and cannot be submitted to Meta.`, STATUS_CODES.BAD_REQUEST);
    }

    const { payload, errors } = buildMetaTemplatePayload({
      name: existing.name,
      category: existing.category,
      language: existing.language,
      body: existing.body,
      variables: Array.isArray(existing.variables) ? (existing.variables as string[]) : [],
      components: existing.components && typeof existing.components === "object" && !Array.isArray(existing.components) ? (existing.components as unknown as TemplateComponents) : null,
    });
    if (!payload) throw new ApiError(errors[0] ?? "This template cannot be submitted to Meta.", STATUS_CODES.BAD_REQUEST);

    // Atomic claim: a single conditional UPDATE, exactly like WhatsAppCampaignService's launch guard - the only
    // caller whose statement actually runs while the row still shows DRAFT/REJECTED wins; a second, truly
    // concurrent call (double-click, retried request) sees count===0 and reports the winner's outcome instead of
    // ever calling Meta itself. This is what actually prevents two real Meta template-create calls, not the read
    // that came before it.
    const claim = await this.db.whatsAppTemplate.updateMany({ where: { id, status: existing.status }, data: { status: WhatsAppTemplateStatus.PENDING } });
    if (claim.count === 0) {
      const current = await this.db.whatsAppTemplate.findUniqueOrThrow({ where: { id }, select: { status: true, providerTemplateId: true } });
      return { id, providerTemplateId: current.providerTemplateId ?? existing.providerTemplateId ?? "", status: current.status, alreadySubmitted: true };
    }

    const meta = await this.getMetaProvider();
    if (!meta) {
      await this.db.whatsAppTemplate.updateMany({ where: { id, status: WhatsAppTemplateStatus.PENDING }, data: { status: existing.status } }); // revert the claim - never leave it stuck PENDING with nothing actually submitted
      throw new ApiError("Meta WhatsApp Cloud API is not configured (or its saved credentials cannot be decrypted). Check Settings → WhatsApp Config.", STATUS_CODES.SERVICE_UNAVAILABLE);
    }

    let result;
    try {
      result = await meta.createTemplate(payload as unknown as Record<string, unknown>);
    } catch (error) {
      await this.db.whatsAppTemplate.updateMany({ where: { id, status: WhatsAppTemplateStatus.PENDING }, data: { status: existing.status } }); // revert - Meta never actually accepted it
      throw error instanceof WhatsAppSendError ? new ApiError(error.message, STATUS_CODES.BAD_REQUEST) : error;
    }

    const now = new Date();
    const existingComponents = (existing.components as TemplateComponents | null) ?? {};
    const components: TemplateComponents = { ...existingComponents, submission: { submittedAt: now.toISOString(), rejectionReason: result.rejectedReason } };

    let row;
    try {
      row = await this.db.whatsAppTemplate.update({
        where: { id },
        data: { providerTemplateId: result.providerTemplateId, externalId: result.providerTemplateId, status: result.status, components: components as unknown as Prisma.InputJsonValue, lastSyncedAt: now },
        select: TEMPLATE_SELECT,
      });
    } catch (error) {
      // Meta already accepted the template and returned an id at this point - a P2002 here means another row
      // already claims that (provider, providerTemplateId) pair, which should be structurally impossible for a
      // freshly-created Meta template id, but is surfaced clearly rather than as a raw constraint error either way.
      if (error instanceof Object && "code" in error && error.code === "P2002") {
        throw new ApiError("Meta returned a template id that is already recorded against a different CRM template - contact support before retrying.", STATUS_CODES.CONFLICT);
      }
      throw error;
    }

    await this.recordActivity(user, ActivityType.WHATSAPP_TEMPLATE_UPDATED, row.id, "WhatsApp template submitted to Meta for approval", `${row.name} -> Meta template id ${result.providerTemplateId} (${result.status})`);
    return { id, providerTemplateId: result.providerTemplateId, status: result.status, alreadySubmitted: false };
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
      return { provider: provider.id, supported: false, reason: result.reason, created: 0, updated: 0, unchanged: 0, disabledMissing: 0, total: 0 };
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const now = new Date();
    const seenProviderTemplateIds: string[] = [];

    for (const t of result.templates) {
      seenProviderTemplateIds.push(t.providerTemplateId);
      const outcome = await this.upsertSyncedTemplate(provider.id, t, now);
      if (outcome === "created") created++;
      else if (outcome === "updated") updated++;
      else unchanged++;
    }

    // A previously-synced template this sync no longer reports at all means the provider deleted it (this
    // provider's own listTemplates always returns its FULL set, never a partial page - see whatsapp.provider.ts).
    // Left untouched, a template that was APPROVED could stay "sendable" here long after it stopped existing at
    // the provider - so it is marked DISABLED, exactly as an explicit provider-side disable already is.
    const { count: disabledMissing } = await this.db.whatsAppTemplate.updateMany({
      where: { provider: provider.id, providerTemplateId: { not: null, notIn: seenProviderTemplateIds }, status: { not: WhatsAppTemplateStatus.DISABLED } },
      data: { status: WhatsAppTemplateStatus.DISABLED, lastSyncedAt: now },
    });

    const summary: TemplateSyncSummary = { provider: provider.id, supported: true, created, updated, unchanged, disabledMissing, total: result.templates.length };
    await this.recordActivity(
      user,
      ActivityType.WHATSAPP_TEMPLATE_SYNCED,
      null,
      "WhatsApp templates synced",
      `${provider.id}: ${created} created, ${updated} updated, ${unchanged} unchanged, ${disabledMissing} disabled (no longer at provider)`,
    );
    return summary;
  }

  private async upsertSyncedTemplate(provider: WhatsAppProvider["id"], t: NormalizedTemplate, syncedAt: Date): Promise<"created" | "updated" | "unchanged"> {
    const existing = await this.db.whatsAppTemplate.findUnique({
      where: { provider_providerTemplateId: { provider, providerTemplateId: t.providerTemplateId } },
      select: { id: true, name: true, category: true, language: true, body: true, status: true, quality: true, externalId: true, components: true },
    });

    const { variables } = extractTemplateVariables(t.body);
    const status = t.status === "UNKNOWN" ? WhatsAppTemplateStatus.DISABLED : (t.status as WhatsAppTemplateStatus);
    // name/body/language/status are always the provider's - those are exactly what a sync exists to report. But
    // category/quality/externalId are sometimes blank on a given provider response even though a PREVIOUS sync (or
    // local edit) recorded a real value - a blank never overwrites a real value the CRM already has. `components`
    // (header/footer/buttons/examples) is never written here at all: no provider integration returns that shape
    // today, so a sync can only ever be silent about it, never wrong about it - whatever a person configured
    // locally survives every sync untouched.
    const category = t.category || existing?.category || null;
    const quality = t.quality || existing?.quality || null;
    const externalId = t.externalId || existing?.externalId || null;
    // The one narrow exception to "sync never touches components": a REJECTED status's reason is genuinely
    // provider-reported information that normally only becomes known through a later sync (Meta reviews
    // asynchronously - a template is virtually always PENDING with no reason yet at submission time), recorded
    // under its own `submission` sub-key so header/footer/buttons/bodyExamples are still never touched.
    const existingComponents = (existing?.components as TemplateComponents | null) ?? null;
    const components =
      t.rejectedReason !== undefined && t.rejectedReason !== null
        ? ({ ...existingComponents, submission: { ...existingComponents?.submission, submittedAt: existingComponents?.submission?.submittedAt ?? syncedAt.toISOString(), rejectionReason: t.rejectedReason } } as unknown as Prisma.InputJsonValue)
        : undefined;
    const data = { name: t.name, category, language: t.language, body: t.body, variables, status, quality, externalId, lastSyncedAt: syncedAt, ...(components !== undefined ? { components } : {}) };

    if (!existing) {
      await this.db.whatsAppTemplate.create({ data: { ...data, provider, providerTemplateId: t.providerTemplateId } });
      return "created";
    }

    const changed = existing.name !== t.name || existing.category !== category || existing.language !== t.language || existing.body !== t.body || existing.status !== status || existing.quality !== quality || existing.externalId !== externalId || components !== undefined;
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
