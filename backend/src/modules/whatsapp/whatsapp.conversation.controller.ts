import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest, AuthUser } from "@/middlewares/auth.js";
import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import WhatsAppOrderConversationService from "./whatsapp.order-conversation.service.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { canViewAllWhatsAppConversations } from "./whatsapp.history.filters.js";
import { ApiError } from "@/utils/apiError.js";

const conversationService = new WhatsAppConversationService();
const orderConversationService = new WhatsAppOrderConversationService();
const freeTextService = new WhatsAppFreeTextService();
const messagingService = new WhatsAppMessagingService();

const assignSchema = z.object({ userId: z.string().uuid() });
// replyToMessageId is the CRM's own internal WhatsAppMessage id (never a client-supplied provider
// wamid, so it can be looked up server-side and scope-checked before trusting it as a reply target).
const sendTextSchema = z.object({ text: z.string().min(1).max(4000), replyToMessageId: z.uuid().optional() });

export const getConversationDetail = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.viewConversationDetail(req.user!, req.params.leadId as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const markConversationRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await conversationService.markRead(req.user!, req.params.leadId as string);
    sendResponse(res, true, null, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const assignConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema(assignSchema, req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await conversationService.assignConversation(req.user!, req.params.leadId as string, value);
    sendResponse(res, true, result, "Conversation assigned.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const handoffConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.handoffToHuman(req.user!, req.params.leadId as string);
    sendResponse(res, true, result, "Conversation handed off to a human.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const returnConversationToAi = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.returnToAi(req.user!, req.params.leadId as string);
    sendResponse(res, true, result, "Conversation returned to AI.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Delete/archive: never deletes the lead, orders, payments or message history - only hides the
// conversation from the normal inbox list (see WhatsAppConversationService's own comment on how,
// with no schema change). Callable from both the open conversation and the inbox list.
export const archiveConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.archiveConversation(req.user!, req.params.leadId as string);
    sendResponse(res, true, result, "Conversation removed from the inbox. The customer, orders and payment records were not affected.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const unarchiveConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.unarchiveConversation(req.user!, req.params.leadId as string);
    sendResponse(res, true, result, "Conversation restored to the inbox.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

/** Free-text send. WhatsAppFreeTextService decides (server-side, never trusting the client) whether it is
 *  allowed: the conversation's active provider must be Meta AND Meta's 24-hour customer-service window must be
 *  open. AiSensy/Gupshup conversations keep their template-only behavior. */
// Exported so the policy is testable on its own. The Inbox is company-wide: ADMIN, MANAGER and SALESPERSON (telecaller) may reply in ANY conversation, whichever team owns the lead (the same
// roles that can read it). Other roles keep the normal lead scope. Only the free-text reply and its capability use this - archive, assign, delete, orders and template management keep their own checks.
export async function loadInboxLead(user: AuthUser, leadId: string, db: DbClient = prisma) {
  const leadScope = canViewAllWhatsAppConversations(user.role) ? {} : await getLeadScope(user, db);
  const lead = await db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true, normalizedMobile: true } });
  if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
  return lead;
}
const loadScopedLead = (req: AuthRequest) => loadInboxLead(req.user!, req.params.leadId as string);

// Resolves a client-supplied CRM message id (the "reply to" / "correct" target - same mechanism for
// both, "Correct Message" is just a pre-filled Reply) to that message's real providerMessageId
// (wamid), scoped to the SAME lead/conversation the send is already scoped to. Exported standalone so
// this exact security/correctness boundary - a message id from another lead's conversation can never
// be used as a reply target, and a message with no real providerMessageId can never be quoted - is
// independently testable without going through the Express req/res layer.
export async function resolveReplyToProviderMessageId(leadId: string, replyToMessageId: string | undefined, db: DbClient = prisma): Promise<string | undefined> {
  if (!replyToMessageId) return undefined;
  const target = await db.whatsAppMessage.findFirst({ where: { id: replyToMessageId, leadId }, select: { providerMessageId: true } });
  if (!target?.providerMessageId) throw new ApiError("The message you're replying to is not available to quote.", STATUS_CODES.BAD_REQUEST);
  return target.providerMessageId;
}

export const sendConversationText = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema(sendTextSchema, req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const lead = await loadScopedLead(req);
    if (!lead.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);

    // The reply/correction target must belong to this same conversation - resolved server-side to its
    // real providerMessageId (wamid), never trusting a client-supplied one directly.
    const replyToProviderMessageId = await resolveReplyToProviderMessageId(lead.id, value.replyToMessageId);

    const row = await freeTextService.sendText({ id: lead.id, normalizedMobile: lead.normalizedMobile }, value.text, req.user!.id, undefined, replyToProviderMessageId);
    sendResponse(res, true, { id: row.id }, "Message sent.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

/** What the inbox needs to render the composer honestly: the conversation's active provider, whether free text is
 *  allowed right now (and why not), and the Meta service-window state. Works for leads with no conversation row yet. */
export const getMessagingCapability = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const lead = await loadScopedLead(req);
    const { capability } = await freeTextService.getCapability(lead.id);
    // Which provider a template send would use (and why not, if it can't): the Send Template dialog filters on this.
    const templates = await messagingService.describeTemplateProvider(req.user!, lead.id);
    sendResponse(res, true, { ...capability, templates }, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrderDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Viewing the draft is read-only; confirmOrderDraft (below) keeps the scoped getConversationDetail check.
    const result = await conversationService.viewConversationDetail(req.user!, req.params.leadId as string);
    sendResponse(res, true, { orderState: result.orderState, orderDraft: result.orderDraft }, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const confirmOrderDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const leadId = req.params.leadId as string;
    // RBAC via the same lead-scope/assignee check every other conversation route uses, before the
    // service acts (which itself always creates as the conversation's assignee - see its own comment).
    await conversationService.getConversationDetail(req.user!, leadId);
    const orderId = await orderConversationService.confirmDraftOrder(leadId, "USER", "Order created from WhatsApp Inbox (AI draft, confirmed by a salesperson)");
    if (!orderId) {
      sendResponse(res, false, null, "Could not create the order - the draft is incomplete, no salesperson is assigned, or it was already created.", STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, { orderId }, "Order created.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
