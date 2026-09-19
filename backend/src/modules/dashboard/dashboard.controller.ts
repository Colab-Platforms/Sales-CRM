import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import DashboardService from "./dashboard.service.js";
import type { AuthRequest } from "@/middlewares/auth.js";

const dashboardService = new DashboardService();

export const getDashboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await dashboardService.getDashboard(req.user!);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
