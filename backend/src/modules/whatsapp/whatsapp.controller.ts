import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { validateCustomerIdParams } from "../customers/customers.validators.js";
import WhatsAppService from "./whatsapp.service.js";
import { validateSendMessageBody } from "./whatsapp.validators.js";
import { validateListConversationsQuery, validateListMessagesQuery, validateMessageIdParams } from "./whatsapp.history.validators.js";

const whatsappService = new WhatsAppService();

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
