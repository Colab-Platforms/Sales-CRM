import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import type { WhatsAppAutomationType } from "../../../generated/prisma/enums.js";
import LifecycleAutomationService from "./whatsapp.automation.service.js";
import { validateAutomationTypeParams, validateUpdateAutomationConfig } from "./whatsapp.automation.validators.js";

const automationService = new LifecycleAutomationService();

export const listAutomationConfigs = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await automationService.listConfigs();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateAutomationConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: paramsError, value: paramsValue } = validateAutomationTypeParams(req.params);
    if (paramsError) {
      sendResponse(res, false, null, paramsError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error, value } = validateUpdateAutomationConfig(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await automationService.updateConfig(req.user!, paramsValue.automationType as WhatsAppAutomationType, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
