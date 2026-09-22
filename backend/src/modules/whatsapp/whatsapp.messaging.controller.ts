import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import { validateOrderConfirmationTest, validatePreviewTemplate, validateSendTemplate } from "./whatsapp.messaging.validators.js";

const messagingService = new WhatsAppMessagingService();

export const previewTemplateMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validatePreviewTemplate(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messagingService.previewTemplate(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const sendTemplateMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSendTemplate(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messagingService.sendTemplate(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Safe, manual test path for the AiSensy order-confirmation template - see
// whatsapp.messaging.service.ts's sendOrderConfirmationTest for the safety rules.
export const sendOrderConfirmationTest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderConfirmationTest(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await messagingService.sendOrderConfirmationTest(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
