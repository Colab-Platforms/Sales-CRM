import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import ReconciliationService from "./reconciliation.service.js";
import { validateListReconciliationQuery } from "./reconciliation.validators.js";

const reconciliationService = new ReconciliationService();

export const getReconciliation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListReconciliationQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await reconciliationService.getReconciliation(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
