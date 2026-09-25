import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import CashfreePaymentsService from "./cashfree.payments.service.js";
import { validateOrderParams, validatePaymentParams, validateSendBody } from "./cashfree.validators.js";

const service = new CashfreePaymentsService();

const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);

export const createPaymentLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderParams(req.params);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const result = await service.createPaymentLink(req.user!, value.orderId);
    sendResponse(res, true, result, result.reused ? "An open payment link already exists for this amount" : "Payment link created", result.reused ? STATUS_CODES.OK : STATUS_CODES.CREATED);
  } catch (error: any) {
    fail(res, error);
  }
};

export const cancelPaymentLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validatePaymentParams(req.params);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.cancelPaymentLink(req.user!, value.paymentId), "Payment link cancelled", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const refreshPaymentLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validatePaymentParams(req.params);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.refreshPaymentLink(req.user!, value.paymentId), "Payment refreshed from Cashfree", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

// When the caller specifies a templateId, the existing explicit-template send runs unchanged. When
// they don't, the provider-aware send decides for itself (Meta free text inside the 24-hour window,
// otherwise an approved template for the resolved provider) - see sendPaymentLinkAuto.
export const sendPaymentLinkWhatsApp = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validatePaymentParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateSendBody(req.body ?? {});
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);

    if (body.value.templateId) {
      sendResponse(res, true, await service.sendPaymentLinkWhatsApp(req.user!, params.value.paymentId, body.value.templateId), "Payment link sent", STATUS_CODES.CREATED);
      return;
    }
    const result = await service.sendPaymentLinkAuto(req.user!, params.value.paymentId);
    sendResponse(res, result.sent, result, result.sent ? "Payment link sent" : (result.reason ?? "Could not send the payment link"), result.sent ? STATUS_CODES.CREATED : STATUS_CODES.BAD_REQUEST);
  } catch (error: any) {
    fail(res, error);
  }
};

export const cashfreeStatus = () => service.status();
