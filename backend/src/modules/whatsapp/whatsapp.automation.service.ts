import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { WhatsAppAutomationType } from "../../../generated/prisma/enums.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import { AUTOMATION_TYPES } from "./whatsapp.automation.types.js";
import type { AutomationConfigView, AutomationOutcome, DispatchInput, UpdateAutomationConfigInput } from "./whatsapp.automation.types.js";

// E7.6 Lifecycle Automation. LifecycleAutomationService -> WhatsAppMessagingService -> WhatsAppProvider
// is the only send path this module ever uses (never AiSensy/Gupshup directly), preserving
// E7.1-E7.5's architecture exactly. dispatch() is deliberately unable to throw: a business event
// (an order sync, a scheduler sweep) that triggers an automation must never fail or roll back
// because WhatsApp is unavailable, misconfigured, or rejects the message - see the doc comment on
// AutomationOutcome.
class LifecycleAutomationService {
  private readonly messaging: WhatsAppMessagingService;

  // messaging defaults to a service bound to this SAME db client (not a separately-hardcoded
  // `prisma`) so that in a test running inside one rolled-back transaction, the automation run
  // claim and the resulting WhatsAppMessage/Activity writes are all part of that one transaction -
  // never silently committed outside it.
  constructor(
    private readonly db: DbClient = prisma,
    messaging?: WhatsAppMessagingService,
  ) {
    this.messaging = messaging ?? new WhatsAppMessagingService(db);
  }

  async listConfigs(): Promise<AutomationConfigView[]> {
    const rows = await this.db.whatsAppAutomationConfig.findMany({
      select: {
        automationType: true,
        enabled: true,
        template: { select: { id: true, name: true, status: true } },
        updatedBy: { select: { id: true, name: true } },
        updatedAt: true,
      },
    });
    const byType = new Map(rows.map((r) => [r.automationType, r]));
    // Every one of the six required types is always represented, even with no row yet - see
    // whatsapp.prisma's WhatsAppAutomationConfig doc comment for why a missing row still means
    // "enabled, nothing configured" rather than "off".
    return AUTOMATION_TYPES.map((automationType) => {
      const row = byType.get(automationType);
      return {
        automationType,
        enabled: row?.enabled ?? true,
        template: row?.template ?? null,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      };
    });
  }

  async updateConfig(user: AuthUser, automationType: WhatsAppAutomationType, input: UpdateAutomationConfigInput): Promise<AutomationConfigView> {
    if (input.templateId) {
      const template = await this.db.whatsAppTemplate.findUnique({ where: { id: input.templateId }, select: { id: true, status: true } });
      if (!template) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
      if (template.status !== "APPROVED") throw new ApiError("Only an APPROVED template can be assigned to an automation", STATUS_CODES.BAD_REQUEST);
    }

    await this.db.whatsAppAutomationConfig.upsert({
      where: { automationType },
      create: { automationType, enabled: input.enabled ?? true, templateId: input.templateId ?? null, updatedById: user.id },
      update: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
        updatedById: user.id,
      },
    });

    const view = (await this.listConfigs()).find((c) => c.automationType === automationType);
    return view!; // automationType is one of AUTOMATION_TYPES, so listConfigs() always includes it
  }

  /**
   * Attempts to fire one automation for one real-world event. Never throws: every failure mode
   * (disabled, no template, template not approved, a required variable missing, no valid mobile,
   * WhatsApp not configured, provider rejection, or a genuinely unexpected error) resolves to a
   * safe AutomationOutcome instead, so a caller reacting to a business event can await this and
   * move on regardless of the result.
   */
  async dispatch(input: DispatchInput): Promise<AutomationOutcome> {
    const runId = randomUUID();
    // The idempotency claim itself: INSERT ... ON CONFLICT (event_key) DO NOTHING, the same
    // race-safe idiom whatsapp.webhook.store.ts and whatsapp.messaging.service.ts already use.
    // Claimed *before* any config/template lookup so every outcome - including "disabled" or "no
    // template configured" - is itself idempotent and auditable, not just the successful path.
    const claim = await this.db.whatsAppAutomationRun.createMany({
      data: [{ id: runId, automationType: input.type, eventKey: input.eventKey, leadId: input.leadId, orderId: input.orderId ?? null, status: "SKIPPED", reason: null }],
      skipDuplicates: true,
    });
    if (claim.count === 0) return { outcome: "duplicate" };

    try {
      const config = await this.resolveConfig(input.type);
      if (!config.enabled) return this.finish(runId, "SKIPPED", "This automation is currently disabled.");
      if (!config.templateId) return this.finish(runId, "SKIPPED", "No WhatsApp template is configured for this automation.");

      const template = await this.db.whatsAppTemplate.findUnique({ where: { id: config.templateId }, select: { status: true } });
      if (!template) return this.finish(runId, "SKIPPED", "The template configured for this automation no longer exists.");
      if (template.status !== "APPROVED") {
        return this.finish(runId, "SKIPPED", `The template configured for this automation is ${template.status}, not APPROVED.`);
      }

      const message = await this.messaging.sendTemplateAsSystem({ leadId: input.leadId, templateId: config.templateId, orderId: input.orderId });
      return this.finish(runId, "SENT", null, message.id);
    } catch (error) {
      // ApiError = an expected, already-descriptive precondition failure (missing variable, no
      // valid mobile, order/customer mismatch, WhatsApp not configured) - a clean skip, not a bug.
      // Anything else is a genuinely unexpected failure in the automation's own execution.
      if (error instanceof ApiError) return this.finish(runId, "SKIPPED", error.message);
      const message = error instanceof Error ? error.message : "Unknown automation error";
      logger.error("WhatsApp lifecycle automation failed unexpectedly", error);
      return this.finish(runId, "FAILED", message);
    }
  }

  private async resolveConfig(type: WhatsAppAutomationType): Promise<{ enabled: boolean; templateId: string | null }> {
    const row = await this.db.whatsAppAutomationConfig.findUnique({ where: { automationType: type }, select: { enabled: true, templateId: true } });
    return row ?? { enabled: true, templateId: null };
  }

  private async finish(runId: string, status: "SENT" | "SKIPPED" | "FAILED", reason: string | null, whatsAppMessageId?: string): Promise<AutomationOutcome> {
    await this.db.whatsAppAutomationRun.update({ where: { id: runId }, data: { status, reason, whatsAppMessageId: whatsAppMessageId ?? null } });
    if (status === "SENT") return { outcome: "sent", runId, whatsAppMessageId: whatsAppMessageId! };
    if (status === "FAILED") return { outcome: "failed", runId, reason: reason! };
    return { outcome: "skipped", runId, reason: reason! };
  }
}

export default LifecycleAutomationService;
