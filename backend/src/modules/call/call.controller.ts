import type { Response } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { initiateCallRequestSchema, type InitiateCallErrorCode } from "@modules/telephony/call.contract.js";
import { getTelephonyService } from "@modules/telephony/telephony.service.js";
import { CallInitiationError, createCallService, type CallService } from "./call.service.js";
import { createPrismaCallInitiationStore } from "./call.store.js";

let cachedService: CallService | undefined;

function getService(): CallService {
  cachedService ??= createCallService({ store: createPrismaCallInitiationStore(prisma), telephony: getTelephonyService() });
  return cachedService;
}

function fail(res: Response, code: InitiateCallErrorCode, message: string, status: number, callId?: string): void {
  // Errors are built here so the global error handler (which echoes the error object) is never used.
  sendResponse(res, false, { code, ...(callId ? { callId } : {}) }, message, status);
}

/** `getSvc` is injectable so route tests can run without the database. */
export function createInitiateCallHandler(getSvc: () => CallService) {
  return async function initiateCall(req: AuthRequest, res: Response): Promise<void> {
    const parsed = initiateCallRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, "INVALID_REQUEST", "A valid leadId is required", STATUS_CODES.BAD_REQUEST);
      return;
    }

    try {
      const result = await getSvc().initiateCall({ id: req.user!.id, role: req.user!.role }, parsed.data);
      sendResponse(res, true, result, "Call initiated", STATUS_CODES.CREATED);
    } catch (err) {
      if (err instanceof CallInitiationError) {
        fail(res, err.code, err.message, err.httpStatus, err.callId);
        return;
      }
      // Only the error name is logged: DB/provider errors can embed connection details or credentials.
      logger.error(`Call initiation: unexpected error category=${err instanceof Error ? err.name : "UnknownError"}`);
      fail(res, "INTERNAL_ERROR", "Something went wrong", STATUS_CODES.SERVER_ERROR);
    }
  };
}

export const initiateCall = createInitiateCallHandler(getService);
