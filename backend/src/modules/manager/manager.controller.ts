import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import ManagerService from "./manager.service.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import {
  validateCreateGroupSchema,
  validateAddSalespersonSchema,
  validateCreateSalespersonSchema,
  validateAddExistingMemberSchema,
  validateUpdateGroupSchema,
  validateUpdateSalespersonSchema,
} from "./manager.validators.js";

const managerService = new ManagerService();

export const createGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateGroupSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await managerService.createGroup(req.user!.id, value);
    sendResponse(res, true, result, "Group created successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listMyGroups = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.listMyGroups(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.getGroupById(req.user!.id, req.params.groupId as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateUpdateGroupSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await managerService.updateGroup(req.user!.id, req.params.groupId as string, value);
    sendResponse(res, true, result, "Group updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const deleteGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.deleteGroup(req.user!.id, req.params.groupId as string);
    sendResponse(res, true, result, "Group deleted successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listSalespersons = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.listAllSalespersons(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listMySalespersons = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await managerService.listMySalespersons(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
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

    const { groupId, ...data } = value;
    const result = await managerService.addNewSalesperson(req.user!.id, groupId, data);
    sendResponse(res, true, result, "Salesperson created.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const addNewSalesperson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAddSalespersonSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await managerService.addNewSalesperson(req.user!.id, req.params.groupId as string, value);
    sendResponse(res, true, result, "Salesperson added to group.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const addExistingSalesperson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAddExistingMemberSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await managerService.addExistingSalesperson(req.user!.id, req.params.groupId as string, value);
    sendResponse(res, true, result, "Salesperson added to group.", STATUS_CODES.OK);
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

    const result = await managerService.updateSalesperson(
      req.user!.id,
      req.params.groupId as string,
      req.params.userId as string,
      value,
    );
    sendResponse(res, true, result, "Salesperson updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const removeSalesperson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await managerService.removeSalesperson(req.user!.id, req.params.groupId as string, req.params.userId as string);
    sendResponse(res, true, null, "Salesperson removed from group.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
