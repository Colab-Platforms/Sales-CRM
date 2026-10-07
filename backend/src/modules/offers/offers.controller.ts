import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import OffersService from "./offers.service.js";

// One shared instance so the in-process cache is shared across requests.
export const offersService = new OffersService();

export const getActiveOffers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await offersService.getActiveOffers();
    sendResponse(res, true, result, "Active offers", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
