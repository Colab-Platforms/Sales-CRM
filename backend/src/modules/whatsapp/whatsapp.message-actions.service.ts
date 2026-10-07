// WhatsApp-style per-message actions: star/unstar, "delete for me", and forward. Every one of these
// is a CRM-side operation on top of the EXISTING shared WhatsAppMessage/WhatsAppConversation system -
// no second messaging architecture, no new provider integration. See the capability matrix in the
// final report for exactly which of these touch Meta/WhatsApp itself versus staying CRM-only.
//
// Starred/hidden state lives on WhatsAppMessageUserState (one row per message+user) rather than a
// column on WhatsAppMessage itself, because both are genuinely per-viewer: two CRM users looking at
// the same conversation must never share either, and "delete for me" must never touch the shared
// WhatsAppMessage row other CRM users (and the real WhatsApp conversation) still see.
//
// Intentionally no "delete for everyone": checked against the current official WhatsApp Cloud API
// reference (graph.facebook.com Messages/Webhooks docs) - there is no endpoint or field anywhere in
// the Cloud API for a business to delete, recall, or unsend a message it already sent. The only
// delete-shaped thing Meta documents is DELETE /{media-id} for an uploaded media asset, which is
// unrelated to recalling a sent message. AiSensy's Campaign API exposes no delete/recall operation at
// all (send-only). Gupshup's status webhook can report a "deleted" event, but that is a status the
// recipient's client reports back to Gupshup (e.g. the customer deleted it on their own phone) - there
// is no corresponding Gupshup API a business calls to request a deletion; whatsapp.gupshup.provider.ts
// already deliberately ignores that event ("enqueued"/"deleted" are not part of our smaller status
// set) because it isn't a status this CRM can act on. So: across every configured provider, "delete
// for everyone" is a real WhatsApp consumer-app feature with no Business/Cloud API equivalent. It is
// not implemented here, and the frontend menu does not offer it (not even disabled) - a disabled
// button would wrongly imply this is close to working rather than simply unsupported.
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { scopedMessageWhere } from "./whatsapp.history.filters.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";

class WhatsAppMessageActionsService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly freeText: WhatsAppFreeTextService = new WhatsAppFreeTextService(prisma),
  ) {}

  // Same RBAC + "out of scope looks like missing" rule every other single-message read already uses.
  private async scopedMessage(user: AuthUser, id: string) {
    const leadScope = await getLeadScope(user, this.db);
    const row = await this.db.whatsAppMessage.findFirst({
      where: scopedMessageWhere(id, leadScope),
      select: { id: true, body: true, messageType: true },
    });
    if (!row) throw new ApiError("Message not found", STATUS_CODES.NOT_FOUND);
    return row;
  }

  async setStarred(user: AuthUser, id: string, starred: boolean): Promise<{ id: string; starred: boolean }> {
    await this.scopedMessage(user, id);
    await this.db.whatsAppMessageUserState.upsert({
      where: { messageId_userId: { messageId: id, userId: user.id } },
      create: { messageId: id, userId: user.id, starred },
      update: { starred },
    });
    return { id, starred };
  }

  // Hides the message from THIS user's own view only - the WhatsAppMessage row, and every other CRM
  // user's ability to see it, is completely untouched. Never calls Meta/WhatsApp: there is nothing to
  // tell the provider, since nothing changed for the customer or for anyone else.
  async deleteForMe(user: AuthUser, id: string): Promise<{ id: string; hidden: boolean }> {
    await this.scopedMessage(user, id);
    await this.db.whatsAppMessageUserState.upsert({
      where: { messageId_userId: { messageId: id, userId: user.id } },
      create: { messageId: id, userId: user.id, hiddenAt: new Date() },
      update: { hiddenAt: new Date() },
    });
    return { id, hidden: true };
  }

  async bulkDeleteForMe(user: AuthUser, ids: string[]): Promise<{ hidden: number }> {
    const leadScope = await getLeadScope(user, this.db);
    const scopedIds = (
      await this.db.whatsAppMessage.findMany({
        where: { AND: [{ id: { in: ids } }, ...(Object.keys(leadScope).length > 0 ? [{ lead: leadScope }] : [])] },
        select: { id: true },
      })
    ).map((r) => r.id);

    if (scopedIds.length === 0) return { hidden: 0 };
    const now = new Date();
    // Each upsert is independent and idempotent (one row per message+user), so these run in parallel
    // rather than as a single $transaction - `this.db` may already BE an active transaction client
    // (e.g. in tests), and Prisma's batch $transaction([...]) opens its own separate connection/
    // transaction that can't see that outer transaction's uncommitted rows.
    await Promise.all(
      scopedIds.map((id) =>
        this.db.whatsAppMessageUserState.upsert({
          where: { messageId_userId: { messageId: id, userId: user.id } },
          create: { messageId: id, userId: user.id, hiddenAt: now },
          update: { hiddenAt: now },
        }),
      ),
    );
    return { hidden: scopedIds.length };
  }

  // NOTE: WhatsApp "Edit Message" (in any form - a direct PATCH of this row, or sending a correction
  // as a new reply) has been removed entirely as a product decision: editing an already-sent WhatsApp
  // message is not supported by this CRM's WhatsApp Business integration, and no replacement workflow
  // was introduced. There is no editMessage()/correction method on this service. The schema column
  // that briefly backed the PATCH design (`edited_at`) has been dropped; the Activity type it used
  // was left in the enum (Postgres can't drop an enum value without recreating the whole type) but was
  // never written by any real data and nothing reads it.

  // Real outbound send through the EXISTING free-text pipeline (whatsapp.freetext.service.ts) - the
  // same Meta 24-hour-window/provider rules every other free-text send already obeys. Text only: the
  // current WhatsAppMessage schema stores no media URL/mime-type for an inbound or outbound MEDIA
  // message (only that one happened), so there is nothing real to re-send for a non-text message -
  // forwarding it would either silently drop the attachment or fabricate one, both refused by design.
  async forward(user: AuthUser, messageId: string, targetLeadId: string): Promise<{ id: string }> {
    const source = await this.scopedMessage(user, messageId);
    if (source.messageType !== "TEXT" || !source.body) {
      throw new ApiError(
        "Only text messages can be forwarded - the CRM does not store the original media for image/document/other message types, so there is nothing to resend.",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const leadScope = await getLeadScope(user, this.db);
    const target = await this.db.lead.findFirst({ where: scopedLeadWhere(targetLeadId, leadScope), select: { id: true, normalizedMobile: true } });
    if (!target) throw new ApiError("Destination customer not found", STATUS_CODES.NOT_FOUND);
    if (!target.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);

    // sendText itself enforces the real Meta-window/provider rule and throws its own clear ApiError
    // if forwarding isn't actually possible right now - never silently faked as sent.
    const row = await this.freeText.sendText({ id: target.id, normalizedMobile: target.normalizedMobile }, source.body, user.id);
    return { id: row.id };
  }
}

export default WhatsAppMessageActionsService;
