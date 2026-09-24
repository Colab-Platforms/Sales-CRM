import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import WhatsAppCloudConfigService from "./whatsapp.cloud-config.service.js";
import { validateCreateWhatsAppCloudConfigSchema } from "./whatsapp.cloud-config.validators.js";

const service = new WhatsAppCloudConfigService();

export const getWhatsAppCloudConfig = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await service.getConfig();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createWhatsAppCloudConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateWhatsAppCloudConfigSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await service.createConfig(req.user!, value);
    sendResponse(res, true, result, "WhatsApp Cloud API configuration saved.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const testWhatsAppCloudConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await service.testConnection(req.user!);
    // Always 200: a failed connection test is a normal, reportable outcome (bad token, unreachable
    // Graph API), not a request error - the frontend branches on result.success in the response body.
    sendResponse(res, true, result, result.message, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const resetWhatsAppCloudConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await service.resetConfig(req.user!);
    sendResponse(res, true, null, "WhatsApp Cloud API configuration reset.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
