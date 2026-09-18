import { Request, Response, NextFunction } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction): void => {
  console.error("Error Handler Middleware:", err);
  const status = err.statusCode || STATUS_CODES.SERVER_ERROR;
  sendResponse(res, false, err, err.message, status);
};
