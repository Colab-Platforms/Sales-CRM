import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { attendanceService } from "./attendance.service.js";
import { presence } from "./attendance.presence.js";
import { validateReportQuerySchema, validateSetStatusSchema } from "./attendance.validators.js";

function fail(res: Response, error: any): void {
  sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
}

function openEventStream(res: Response): void {
  res.writeHead(STATUS_CODES.OK, {
    "Content-Type": "text/event-stream",
    // no-transform keeps the compression middleware from buffering the stream; X-Accel-Buffering does the same for proxies.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
}

export const startShift = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await attendanceService.startSession(req.user!.id);
    sendResponse(res, true, await attendanceService.getMine(req.user!.id), "Shift started.", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const setStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSetStatusSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await attendanceService.setManualStatus(req.user!.id, value.status);
    sendResponse(res, true, result, "Status updated.", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const endShift = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await attendanceService.endSession(req.user!.id);
    sendResponse(res, true, null, "Shift ended.", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const heartbeat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await attendanceService.heartbeat(req.user!.id);
    sendResponse(res, true, null, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getMyShift = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await attendanceService.getMine(req.user!.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

// The salesperson's presence line: while this stream is open the browser counts as connected. It only
// carries that salesperson's own status events plus keep-alive pings (see attendance.presence.ts).
export const streamMyPresence = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  openEventStream(res);
  presence.openUserStream(userId, res);
  res.on("close", () => presence.closeUserStream(userId, res));
  attendanceService.markConnected(userId).catch((e) => logger.error("[attendance] markConnected failed", e));
};

export const getTeam = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await attendanceService.getTeam(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const streamTeam = async (req: AuthRequest, res: Response): Promise<void> => {
  openEventStream(res);
  presence.addTeamSubscriber(res, { userId: req.user!.id, role: req.user!.role });
  res.on("close", () => presence.removeTeamSubscriber(res));
};

export const getReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateReportQuerySchema(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await attendanceService.getReport(req.user!, value.date, value.userId);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
