import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { fullName } from "../orders/orders.filters.js";
import { canViewAllWhatsAppConversations } from "./whatsapp.history.filters.js";
import WhatsAppMessagingService, { TEMPLATE_STATUS_MESSAGES } from "./whatsapp.messaging.service.js";
import type { BulkClassifyInput, BulkClassifyResult, BulkRecipient, BulkRecipientStatus, BulkSendInput, BulkSendRecipientResult, BulkSendResult } from "./whatsapp.bulk-send.types.js";

// Parts 3-5 (WhatsApp Inbox: selected-chat/bulk sending). This is deliberately NOT a second messaging
// engine: every actual send goes through WhatsAppMessagingService.sendTemplate - the exact same
// APPROVED-only, provider-routing, 24-hour-window, duplicate-guard, opt-out-respecting path a single
// "Send WhatsApp" already uses. This file's only job is: classify a caller-selected list of leads
// against a template (never silently skip a reason), then loop the send over the eligible ones.
//
// For a small, manually selected set of chats (the Inbox's own "select chats -> Send Template" flow)
// this direct per-lead loop is the right tool; a large filter-based audience already has its own
// engine in whatsapp.campaign.service.ts (WhatsAppCampaignService), which this deliberately does not
// duplicate or replace.
const EMPTY_SUMMARY: Record<BulkRecipientStatus, number> = {
  READY: 0,
  MISSING_VARIABLE: 0,
  OPTED_OUT: 0,
  INVALID_PHONE: 0,
  TEMPLATE_NOT_SENDABLE: 0,
  PROVIDER_ERROR: 0,
  CUSTOMER_DEACTIVATED: 0,
  NOT_FOUND: 0,
  NOT_ALLOWED: 0,
  DUPLICATE_PHONE: 0,
};

class WhatsAppBulkSendService {
  private readonly messaging: WhatsAppMessagingService;

  constructor(
    private readonly db: DbClient = prisma,
    messaging?: WhatsAppMessagingService,
  ) {
    // Bound to the same db client as this service, so a test running inside one rolled-back
    // transaction never has a sibling service silently writing/reading outside it.
    this.messaging = messaging ?? new WhatsAppMessagingService(db);
  }

  async classifyRecipients(user: AuthUser, input: BulkClassifyInput): Promise<BulkClassifyResult> {
    if (input.leadIds.length === 0) throw new ApiError("Select at least one chat to send to", STATUS_CODES.BAD_REQUEST);

    const template = await this.db.whatsAppTemplate.findUnique({ where: { id: input.templateId }, select: { id: true, name: true, status: true, provider: true } });
    if (!template) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);

    const leadScope = await getLeadScope(user, this.db);
    // A selected id is normally a lead id (the Inbox lists one conversation per customer, keyed by its lead). An id that is really a CONVERSATION id is resolved to its lead rather than
    // being reported as an unknown customer.
    const requested = Array.from(new Set(input.leadIds));
    const asLeads = await this.db.lead.findMany({ where: { id: { in: requested } }, select: { id: true } });
    const known = new Set(asLeads.map((l) => l.id));
    const conversations = await this.db.whatsAppConversation.findMany({ where: { id: { in: requested.filter((id) => !known.has(id)) } }, select: { id: true, leadId: true } });
    const resolvedId = new Map(requested.map((id) => [id, conversations.find((c) => c.id === id)?.leadId ?? id]));
    const uniqueIds = Array.from(new Set(requested.map((id) => resolvedId.get(id)!)));

    // Who may be messaged: the caller's own lead scope, plus - for ADMIN, MANAGER and SALESPERSON (telecaller), who share the company-wide Inbox - any customer that already HAS a WhatsApp
    // conversation, whichever team owns it (the same rule a single template send applies). Everyone else keeps the normal scope only.
    const selectFields = { id: true, firstName: true, lastName: true, mobile: true, normalizedMobile: true, workingStatus: true } as const;
    const leads = await this.db.lead.findMany({
      // (an empty scope - ADMIN - already means "every lead"; it must not be put inside an OR, where Prisma does not read {} as match-all)
      where: { AND: [{ id: { in: uniqueIds } }, Object.keys(leadScope).length === 0 || !canViewAllWhatsAppConversations(user.role) ? leadScope : { OR: [leadScope, { whatsAppMessages: { some: {} } }] }] },
      select: selectFields,
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    // For an id that is not allowed, tell a record that does not exist apart from one the caller may not message - they need different fixes.
    const existing = new Set((await this.db.lead.findMany({ where: { id: { in: uniqueIds.filter((id) => !byId.has(id)) } }, select: { id: true } })).map((l) => l.id));
    const missingReason = "This chat is not linked to a customer record, so there is no phone number to message";
    const notAllowedReason = "You do not have access to message this customer (it has no WhatsApp conversation and belongs to another team)";

    // A template that is not APPROVED can never send to anyone - one check, not one per recipient.
    const templateBlockedReason = template.status !== "APPROVED" ? (TEMPLATE_STATUS_MESSAGES[template.status] ?? "This template cannot be sent.") : null;

    const optedOutIds = new Set(
      (
        await this.db.communicationPreference.findMany({
          where: { leadId: { in: uniqueIds }, channel: "WHATSAPP", status: "OPTED_OUT" },
          select: { leadId: true },
        })
      ).map((p) => p.leadId),
    );

    const recipients: BulkRecipient[] = [];
    for (const leadId of uniqueIds) {
      const lead = byId.get(leadId);
      if (!lead) {
        if (existing.has(leadId)) recipients.push({ leadId, name: "Unavailable customer", mobile: null, status: "NOT_ALLOWED", reason: notAllowedReason, resolvedBody: null });
        else recipients.push({ leadId, name: "Unlinked chat", mobile: null, status: "NOT_FOUND", reason: missingReason, resolvedBody: null });
        continue;
      }
      const name = fullName(lead.firstName, lead.lastName);
      const mobile = lead.mobile ?? lead.normalizedMobile;

      // A deactivated customer (Part 8) must never receive a message, bulk or otherwise - checked
      // before opt-out/phone/template so it's always the specific, honest reason shown.
      if (lead.workingStatus === "DEACTIVATED") {
        recipients.push({ leadId, name, mobile, status: "CUSTOMER_DEACTIVATED", reason: "This customer's profile has been deactivated", resolvedBody: null });
        continue;
      }
      if (!mobile) {
        recipients.push({ leadId, name, mobile: null, status: "INVALID_PHONE", reason: "This customer has no valid WhatsApp/mobile number on file", resolvedBody: null });
        continue;
      }
      if (optedOutIds.has(leadId)) {
        recipients.push({ leadId, name, mobile, status: "OPTED_OUT", reason: "This customer has opted out of WhatsApp messages", resolvedBody: null });
        continue;
      }
      if (templateBlockedReason) {
        recipients.push({ leadId, name, mobile, status: "TEMPLATE_NOT_SENDABLE", reason: templateBlockedReason, resolvedBody: null });
        continue;
      }

      const provider = await this.messaging.describeTemplateProvider(user, leadId);
      if (provider.message) {
        recipients.push({ leadId, name, mobile, status: "PROVIDER_ERROR", reason: provider.message, resolvedBody: null });
        continue;
      }
      // describeTemplateProvider only confirms A provider is reachable for this lead - it does not
      // know which template we're asking about, so the "does it match THIS template's own provider"
      // check (the same one sendTemplate enforces) happens here.
      if (provider.provider !== template.provider) {
        recipients.push({
          leadId,
          name,
          mobile,
          status: "PROVIDER_ERROR",
          reason: `This template belongs to ${template.provider}, but this conversation's provider is ${provider.provider}.`,
          resolvedBody: null,
        });
        continue;
      }

      try {
        const preview = await this.messaging.previewTemplate(user, { leadId, templateId: input.templateId, manualValues: input.manualValues });
        const missing = preview.fields.filter((f) => f.value === null);
        if (missing.length > 0) {
          recipients.push({ leadId, name, mobile, status: "MISSING_VARIABLE", reason: `Value required for ${missing.map((f) => f.name).join(", ")}`, resolvedBody: null });
          continue;
        }
        recipients.push({ leadId, name, mobile, status: "READY", reason: null, resolvedBody: preview.resolvedBody });
      } catch (error) {
        recipients.push({ leadId, name, mobile, status: "PROVIDER_ERROR", reason: error instanceof ApiError ? error.message : "Could not resolve this message", resolvedBody: null });
      }
    }

    // One customer = one message: leads that share a phone number (duplicates) are sent to ONCE - the first selected one is kept, the rest are excluded with that reason.
    const sentTo = new Map<string, string>();
    for (const r of recipients) {
      if (r.status !== "READY" || !r.mobile) continue;
      const phone = normalizeMobile(r.mobile) ?? r.mobile;
      const first = sentTo.get(phone);
      if (first) {
        r.status = "DUPLICATE_PHONE";
        r.reason = `Same phone number as ${first} - the message goes to that customer once`;
        r.resolvedBody = null;
      } else sentTo.set(phone, r.name);
    }

    const summary = { ...EMPTY_SUMMARY };
    for (const r of recipients) summary[r.status] += 1;

    return { templateId: template.id, templateName: template.name, recipients, summary };
  }

  // Sends only to recipients classified READY - every other recipient is returned unsent with the
  // exact same classification/reason it was shown at review time, never attempted, never silently
  // dropped from the response.
  async sendBulk(user: AuthUser, input: BulkSendInput): Promise<BulkSendResult> {
    const classified = await this.classifyRecipients(user, input);

    const results: BulkSendRecipientResult[] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const recipient of classified.recipients) {
      if (recipient.status !== "READY") {
        results.push({ leadId: recipient.leadId, name: recipient.name, status: recipient.status, reason: recipient.reason });
        skipped += 1;
        continue;
      }

      try {
        const message = await this.messaging.sendTemplate(user, { leadId: recipient.leadId, templateId: input.templateId, manualValues: input.manualValues });
        if (message.status === "FAILED") {
          results.push({ leadId: recipient.leadId, name: recipient.name, status: "FAILED", reason: message.errorMessage ?? "The provider rejected this message" });
          failed += 1;
        } else {
          results.push({ leadId: recipient.leadId, name: recipient.name, status: "SENT", reason: null });
          sent += 1;
        }
      } catch (error) {
        results.push({ leadId: recipient.leadId, name: recipient.name, status: "FAILED", reason: error instanceof ApiError ? error.message : "Could not send this message" });
        failed += 1;
      }
    }

    return { templateId: input.templateId, sent, failed, skipped, recipients: results };
  }
}

export default WhatsAppBulkSendService;
