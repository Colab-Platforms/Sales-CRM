import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import WhatsAppBulkSendService from "./whatsapp.bulk-send.service.js";
import { validateBulkClassify, validateBulkSend } from "./whatsapp.bulk-send.validators.js";

const bulkSendService = new WhatsAppBulkSendService();

// Review step (Parts 3/5): classifies every selected chat before anything is sent, never sends.
export const classifyBulkRecipients = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkClassify(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await bulkSendService.classifyRecipients(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const sendBulkTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkSend(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await bulkSendService.sendBulk(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
