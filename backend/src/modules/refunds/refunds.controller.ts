import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import RefundsService from "./refunds.service.js";
import RefundExecutionService from "./refunds.execution.js";
import CashfreeIdResolutionService from "./refunds.resolve.js";
import { refreshShopifyRefundable } from "./refunds.autoverify.js";
import { validateCreateBody, validateDecisionBody, validateIdParams, validateListQuery, validateOrderParams, validateOrderPaymentParams, validateRejectBody } from "./refunds.validators.js";

const service = new RefundsService();
const execution = new RefundExecutionService();
const idResolution = new CashfreeIdResolutionService();
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

// Refund EXECUTION: sends an APPROVED request to Cashfree. Idempotent: a request already processing / completed is returned, never sent twice.
export const executeRefundRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const result = await execution.execute(req.user!, params.value.id);
    sendResponse(res, true, result.request, result.sentToProvider ? "Refund sent to Cashfree. It is processing until Cashfree confirms it." : "This refund is already in progress or completed.", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

// Reads the refund from Cashfree (read-only) and applies its status: this is what completes (or fails) a PROCESSING refund.
export const refreshRefundExecution = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    sendResponse(res, true, await execution.refresh(req.user!, params.value.id), "Refund status refreshed from Cashfree", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

// Looks up and verifies the Cashfree references of a Shopify-synced Cashfree payment (read-only toward Shopify and Cashfree) so it can be refunded.
export const resolveCashfreeReferences = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderPaymentParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const result = await idResolution.resolve(req.user!, params.value.orderId, params.value.paymentId);
    // The same retry also re-reads Shopify's refundable amount (what a sync does), so an order synced earlier is not stuck on it. Best effort.
    await refreshShopifyRefundable(params.value.orderId).catch(() => false);
    sendResponse(res, true, result, result.resolved ? "Cashfree references verified" : "The Cashfree references could not be verified", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
