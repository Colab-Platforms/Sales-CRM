import { Request, Response, NextFunction } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { classifyDatabaseError, sendDatabaseUnavailable } from "@/utils/databaseErrors.js";

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction): void => {
  console.error("Error Handler Middleware:", err);
  // A database that is down, over quota or out of connections: a plain, safe 503 - never the raw Prisma message or the error object.
  const database = classifyDatabaseError(err);
  if (database) {
    sendDatabaseUnavailable(res, database);
    return;
  }
  const status = err.statusCode || STATUS_CODES.SERVER_ERROR;
  sendResponse(res, false, err, err.message, status);
};
