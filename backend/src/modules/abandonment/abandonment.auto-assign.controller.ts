import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import AbandonmentAutoAssignService from "./abandonment.auto-assign.service.js";
import { validateSetAutoAssignEnabled, validateSetManagerAutoAssignConfig } from "./abandonment.auto-assign.validators.js";

const service = new AbandonmentAutoAssignService();

const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
const bad = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const getManagerAutoAssignConfig = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.getManagerConfig(), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const updateManagerAutoAssignConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSetManagerAutoAssignConfig(req.body);
    if (error) return void bad(res, error.message);
    const result = await service.setManagerConfig(req.user!, value.enabled, value.managerIds);
    sendResponse(res, true, result, `Auto-assignment to managers ${result.enabled ? "enabled" : "disabled"}.`, STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getSalespersonAutoAssignConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.getSalespersonConfig(req.user!.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const updateSalespersonAutoAssignConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSetAutoAssignEnabled(req.body);
    if (error) return void bad(res, error.message);
    const result = await service.setSalespersonConfig(req.user!.id, value.enabled);
    sendResponse(res, true, result, `Auto-assignment to your salespeople ${result.enabled ? "enabled" : "disabled"}.`, STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
