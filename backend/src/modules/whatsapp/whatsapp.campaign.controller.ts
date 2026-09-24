import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import WhatsAppCampaignService from "./whatsapp.campaign.service.js";
import {
  validateAudienceFilters,
  validateCampaignIdParams,
  validateCreateCampaign,
  validateLaunchCampaign,
  validateListCampaignsQuery,
  validateListRecipientsQuery,
  validateUpdateCampaign,
} from "./whatsapp.campaign.validators.js";

const campaignService = new WhatsAppCampaignService();

export const previewCampaignAudience = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAudienceFilters(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.previewAudience(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateCampaign(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.createCampaign(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateCampaignIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error, value } = validateUpdateCampaign(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.updateCampaign(req.user!, idValue.id, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCampaignIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.getCampaign(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listCampaigns = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListCampaignsQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.listCampaigns(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listCampaignRecipients = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateCampaignIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error, value } = validateListRecipientsQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.listRecipients(req.user!, idValue.id, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const launchCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateCampaignIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error, value } = validateLaunchCampaign(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.launchCampaign(req.user!, idValue.id, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const cancelCampaign = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCampaignIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await campaignService.cancelCampaign(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
