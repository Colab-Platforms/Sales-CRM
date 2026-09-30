import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import CustomersLiveService from "./customers.live.service.js";
import { validateLiveCustomersQuery } from "./customers.live.validators.js";

const customersLiveService = new CustomersLiveService();

// Never fails the request just because Shopify is down/slow - CustomersLiveService already reports
// that as result.error, so the frontend gets a clean 200 with an actionable message instead of a 5xx.
export const listLiveCustomers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateLiveCustomersQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await customersLiveService.listLiveCustomers(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
