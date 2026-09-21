import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { validateCustomerIdParams } from "../customers/customers.validators.js";
import { validateOrderIdParams } from "../orders/orders.validators.js";
import AuditService from "./audit.service.js";
import { validateEntityAuditQuery, validateListAuditQuery } from "./audit.validators.js";

const auditService = new AuditService();

export const listAudit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListAuditQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await auditService.listAudit(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrderAudit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateOrderIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { error: queryError, value: queryValue } = validateEntityAuditQuery(req.query);
    if (queryError) {
      sendResponse(res, false, null, queryError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await auditService.getOrderAudit(req.user!, idValue.id, queryValue);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getCustomerAudit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: idError, value: idValue } = validateCustomerIdParams(req.params);
    if (idError) {
      sendResponse(res, false, null, idError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { error: queryError, value: queryValue } = validateEntityAuditQuery(req.query);
    if (queryError) {
      sendResponse(res, false, null, queryError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await auditService.getCustomerAudit(req.user!, idValue.leadId, queryValue);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
