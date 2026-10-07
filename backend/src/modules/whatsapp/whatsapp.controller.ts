import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { validateCustomerIdParams } from "../customers/customers.validators.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppMessageActionsService from "./whatsapp.message-actions.service.js";
import { validateSendMessageBody } from "./whatsapp.validators.js";
import {
  validateBulkDeleteForMeBody,
  validateForwardMessageBody,
  validateListConversationsQuery,
  validateListMessagesQuery,
  validateMessageIdParams,
  validateStarredQuery,
} from "./whatsapp.history.validators.js";

const whatsappService = new WhatsAppService();
const messageActionsService = new WhatsAppMessageActionsService();

export const getWhatsAppStatus = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = whatsappService.getStatus();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const sendWhatsAppMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSendMessageBody(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await whatsappService.sendTemplateMessage(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getCustomerWhatsAppStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCustomerIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await whatsappService.getCustomerWhatsAppStatus(req.user!, value.leadId);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// E7.4: read-only message history/conversation view.

export const listWhatsAppMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListMessagesQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await whatsappService.listMessages(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getWhatsAppMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateMessageIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await whatsappService.getMessage(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// ---- WhatsApp-style per-message actions (star/unstar, delete for me, bulk delete for me, forward).
// See whatsapp.message-actions.service.ts for exactly what each one does and doesn't touch. ----

export const listStarredMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateStarredQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await whatsappService.listStarredMessages(req.user!, value.leadId);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const starMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateMessageIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messageActionsService.setStarred(req.user!, value.id, true);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const unstarMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateMessageIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messageActionsService.setStarred(req.user!, value.id, false);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const deleteMessageForMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateMessageIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messageActionsService.deleteForMe(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const bulkDeleteMessagesForMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkDeleteForMeBody(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messageActionsService.bulkDeleteForMe(req.user!, value.ids);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const forwardMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateMessageIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error, value } = validateForwardMessageBody(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messageActionsService.forward(req.user!, idValue.id, value.targetLeadId);
    sendResponse(res, true, result, "Message forwarded.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// "Edit" (redesigned): no longer a PATCH of this message's own row. A corrected message is now sent
// as a brand-new outbound message through the existing sendConversationText
// (whatsapp.conversation.controller.ts) with replyToMessageId - there is no separate "edit" endpoint
// to call. See whatsapp.message-actions.service.ts's own comment for the full reasoning.

// Central WhatsApp Inbox's left-hand conversation list.
export const listWhatsAppConversations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListConversationsQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await whatsappService.listConversations(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
