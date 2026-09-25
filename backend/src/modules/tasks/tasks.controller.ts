import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import TasksService from "./tasks.service.js";
import { validateSnoozeTaskSchema, validateTaskIdParamSchema } from "./tasks.validators.js";

const tasksService = new TasksService();

export const listMyFollowUps = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await tasksService.listMyFollowUps(req.user!);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const completeTask = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateTaskIdParamSchema(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await tasksService.completeTask(req.user!, value.id);
    sendResponse(res, true, result, "Reminder marked done.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const snoozeTask = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: paramError, value: params } = validateTaskIdParamSchema(req.params);
    if (paramError) {
      sendResponse(res, false, null, paramError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error: bodyError, value: body } = validateSnoozeTaskSchema(req.body);
    if (bodyError) {
      sendResponse(res, false, null, bodyError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await tasksService.snoozeTask(req.user!, params.id, body.minutes);
    sendResponse(res, true, result, "Reminder snoozed.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
