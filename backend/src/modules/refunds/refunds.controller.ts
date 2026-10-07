import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import RefundsService from "./refunds.service.js";
import { validateCreateBody, validateDecisionBody, validateIdParams, validateListQuery, validateOrderParams, validateRejectBody } from "./refunds.validators.js";

const service = new RefundsService();
const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
const bad = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const createRefundRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateCreateBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    const result = await service.createRequest(req.user!, params.value.orderId, body.value);
    sendResponse(res, true, result, "Refund request submitted for approval", STATUS_CODES.CREATED);
  } catch (error: any) {
    fail(res, error);
  }
};

export const listRefundRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListQuery(req.query);
    if (error) return void bad(res, error.message);
    sendResponse(res, true, await service.list(req.user!, value), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getPendingRefundCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.pendingCount(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const approveRefundRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateDecisionBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await service.approve(req.user!, params.value.id, body.value.note), "Refund request approved. The refund has not been issued yet.", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const rejectRefundRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateRejectBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await service.reject(req.user!, params.value.id, body.value.note), "Refund request rejected", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
