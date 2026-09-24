import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import CustomersService from "./customers.service.js";
import { validateCustomerIdParams, validateListCustomersQuery, validateListTimelineQuery } from "./customers.validators.js";

const customersService = new CustomersService();

export const listCustomers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListCustomersQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await customersService.listCustomers(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getCustomer360 = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCustomerIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await customersService.getCustomer360(req.user!, value.leadId);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getNextBestAction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCustomerIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await customersService.getNextBestAction(req.user!, value.leadId);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getCustomerTimeline = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateCustomerIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { error: queryError, value: queryValue } = validateListTimelineQuery(req.query);
    if (queryError) {
      sendResponse(res, false, null, queryError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await customersService.getTimeline(req.user!, idValue.leadId, queryValue);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
