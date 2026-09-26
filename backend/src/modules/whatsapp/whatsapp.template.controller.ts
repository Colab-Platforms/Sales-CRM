import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import WhatsAppTemplateService from "./whatsapp.template.service.js";
import {
  validateCreateTemplate,
  validateListTemplatesQuery,
  validateTemplateIdParams,
  validateUpdateTemplate,
} from "./whatsapp.template.validators.js";

const templateService = new WhatsAppTemplateService();

export const listTemplates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListTemplatesQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await templateService.listTemplates(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateTemplateIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await templateService.getTemplate(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateTemplate(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await templateService.createTemplate(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateTemplateIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error, value } = validateUpdateTemplate(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await templateService.updateTemplate(req.user!, idValue.id, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const deleteTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateTemplateIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await templateService.deleteTemplate(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const syncTemplates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Optional body { provider: "META" } syncs from the Meta Cloud API config; no body keeps the legacy provider sync.
    const only = req.body?.provider === "META" ? "META" : undefined;
    const result = await templateService.syncTemplates(req.user!, only);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
