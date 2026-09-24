import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import AdminService from "./admin.service.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import {
  validateCreateManagerSchema,
  validateCreateSalespersonSchema,
  validateUpdateManagerSchema,
  validateUpdateSalespersonSchema,
} from "./admin.validators.js";

const adminService = new AdminService();

export const createManager = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateManagerSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await adminService.createManager(value);
    sendResponse(res, true, result, "Manager created successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listManagers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await adminService.listManagers();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getManager = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await adminService.getManagerById(req.params.id as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateManager = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateUpdateManagerSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await adminService.updateManager(req.params.id as string, value);
    sendResponse(res, true, result, "Manager updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const deactivateManager = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await adminService.deactivateManager(req.params.id as string);
    sendResponse(res, true, result, "Manager deactivated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createSalesperson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateSalespersonSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await adminService.createSalesperson(req.user!.id, value);
    sendResponse(res, true, result, "Salesperson created successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listSalespersons = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await adminService.listSalespersons();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateSalesperson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateUpdateSalespersonSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await adminService.updateSalesperson(req.params.id as string, value);
    sendResponse(res, true, result, "Salesperson updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
