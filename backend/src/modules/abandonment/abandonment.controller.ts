import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import AbandonmentService from "./abandonment.service.js";
import { validateCreateRecoveryAction, validateIdParams, validateListAbandonmentsQuery, validateUpdateStatus } from "./abandonment.validators.js";

const service = new AbandonmentService();

const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
const bad = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const listAbandonments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListAbandonmentsQuery(req.query);
    if (error) return void bad(res, error.message);
    sendResponse(res, true, await service.listAbandonments(req.user!, value), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getAbandonment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    sendResponse(res, true, await service.getAbandonment(req.user!, params.value.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const createRecoveryAction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateCreateRecoveryAction(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await service.createRecoveryAction(req.user!, params.value.id, body.value), "Recovery action logged", STATUS_CODES.CREATED);
  } catch (error: any) {
    fail(res, error);
  }
};

export const updateAbandonmentStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateUpdateStatus(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await service.updateStatus(req.user!, params.value.id, body.value), "Status updated", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
