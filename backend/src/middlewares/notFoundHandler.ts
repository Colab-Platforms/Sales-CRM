import { Request, Response, NextFunction } from "express";
import STATUS_CODES from "@/utils/statusCodes.js";
import { sendResponse } from "@/utils/responseUtils.js";

export const notFoundHandler = (req: Request, res: Response, _next: NextFunction) => {
  const msg = `Route not found: ${req.method} ${req.originalUrl}`;
  console.error(msg);
  sendResponse(res, false, null, "Route not found", STATUS_CODES.NOT_FOUND);
};
