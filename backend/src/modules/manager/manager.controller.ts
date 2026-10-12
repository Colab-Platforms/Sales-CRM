import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import ManagerService from "./manager.service.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { managerAnalyticsService } from "./manager.analytics.js";
import { validateAnalyticsQuery } from "./manager.analytics.validators.js";

const managerService = new ManagerService();

export const listMyGroups = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.listMyGroups(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.getGroupById(req.user!.id, req.params.groupId as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listMySalespersons = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.listMySalespersons(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getAnalyticsOverview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAnalyticsQuery(req.query);
    if (error) return sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const result = await managerAnalyticsService.overview(req.user!.id, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getSalespersonAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAnalyticsQuery({ ...req.query, salespersonId: req.params.salespersonId });
    if (error) return sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const result = await managerAnalyticsService.salesperson(req.user!.id, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
