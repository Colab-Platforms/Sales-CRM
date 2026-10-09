import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import GroupMembershipRequestsService from "./group-membership-requests.service.js";
import {
  validateCreateMembershipRequestSchema,
  validateDecisionSchema,
  validateListMembershipRequestsQuery,
  validateRejectDecisionSchema,
} from "./group-membership-requests.validators.js";

const service = new GroupMembershipRequestsService();

export const createMembershipRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateMembershipRequestSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await service.createRequest(req.user!, value);
    sendResponse(res, true, result, "Request submitted for approval.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listMembershipRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListMembershipRequestsQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await service.list(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getPendingMembershipRequestCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await service.pendingCount(req.user!);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const approveMembershipRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateDecisionSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await service.approve(req.user!, req.params.id as string, value.note);
    sendResponse(res, true, result, "Request approved.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const rejectMembershipRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateRejectDecisionSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await service.reject(req.user!, req.params.id as string, value.note as string);
    sendResponse(res, true, result, "Request rejected.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
