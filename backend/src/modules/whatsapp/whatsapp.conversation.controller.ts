import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import WhatsAppOrderConversationService from "./whatsapp.order-conversation.service.js";
import { getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { ApiError } from "@/utils/apiError.js";

const conversationService = new WhatsAppConversationService();
const orderConversationService = new WhatsAppOrderConversationService();

const assignSchema = z.object({ userId: z.string().uuid() });
const sendTextSchema = z.object({ text: z.string().min(1).max(4000) });

export const getConversationDetail = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.getConversationDetail(req.user!, req.params.leadId as string);
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

/** Free-text send - only reachable when the conversation's active provider is Meta. AiSensy/Gupshup
 *  have no free-text send capability today (see whatsapp.order-conversation.service.ts's header
 *  comment); this route makes that limitation explicit instead of silently failing at the provider. */
export const sendConversationText = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema(sendTextSchema, req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const leadId = req.params.leadId as string;
    const leadScope = await getLeadScope(req.user!);
    const lead = await prisma.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true, normalizedMobile: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    if (!lead.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);

    const provider = await getMetaWhatsAppProvider();
    if (!provider) throw new ApiError("Free-text sending needs the Meta WhatsApp Cloud API provider - this conversation's active provider does not support it. Use a template message instead.", STATUS_CODES.BAD_REQUEST);

    const result = await provider.sendText({ to: lead.normalizedMobile, body: value.text });
    const row = await prisma.whatsAppMessage.create({
      data: {
        provider: "META",
        providerMessageId: result.providerMessageId,
        direction: "OUTBOUND",
        messageType: "TEXT",
        status: result.providerMessageId ? "SENT" : "QUEUED",
        leadId: lead.id,
        toNumber: lead.normalizedMobile,
        normalizedContact: lead.normalizedMobile,
        body: value.text,
        sentById: req.user!.id,
        sentAt: new Date(),
      },
      select: { id: true },
    });
    sendResponse(res, true, { id: row.id }, "Message sent.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrderDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await conversationService.getConversationDetail(req.user!, req.params.leadId as string);
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
