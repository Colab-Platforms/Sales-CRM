import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { performanceMatrixService } from "./matrix.service.js";
import { validateMatrixQuery } from "./matrix.validators.js";

export const getMatrix = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateMatrixQuery(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await performanceMatrixService.report(req.user!, value), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    if (!error.statusCode) logger.error("Performance matrix report failed", error);
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
