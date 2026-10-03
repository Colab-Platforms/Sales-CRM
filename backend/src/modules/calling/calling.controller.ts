import { Request, Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import CallingService from "./calling.service.js";
import { transcriptEventName, transcriptEvents, type TranscriptEventPayload } from "./calling.events.js";
import {
  validateLeadIdParamSchema,
  validateInitiateCallBodySchema,
  validateVirtualNumberIdParamSchema,
  validateCreateVirtualNumberSchema,
  validateUpdateVirtualNumberSchema,
  validateCallIdParamSchema,
  validateSubmitCallOutcomeSchema,
} from "./calling.validators.js";

const callingService = new CallingService();

export const listVirtualNumbers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await callingService.listActiveVirtualNumbers();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listAllVirtualNumbers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await callingService.listVirtualNumbers();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createVirtualNumber = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateVirtualNumberSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await callingService.createVirtualNumber(value);
    sendResponse(res, true, result, "Virtual number created successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateVirtualNumber = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: paramError, value: params } = validateVirtualNumberIdParamSchema(req.params);
    if (paramError) {
      sendResponse(res, false, null, paramError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error: bodyError, value: body } = validateUpdateVirtualNumberSchema(req.body);
    if (bodyError) {
      sendResponse(res, false, null, bodyError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await callingService.updateVirtualNumber(params.id, body);
    sendResponse(res, true, result, "Virtual number updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const deleteVirtualNumber = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateVirtualNumberIdParamSchema(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    await callingService.deleteVirtualNumber(value.id);
    sendResponse(res, true, null, "Virtual number deleted successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const initiateCall = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: paramError, value: params } = validateLeadIdParamSchema(req.params);
    if (paramError) {
      sendResponse(res, false, null, paramError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error: bodyError, value: body } = validateInitiateCallBodySchema(req.body);
    if (bodyError) {
      sendResponse(res, false, null, bodyError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await callingService.initiateCall(req.user!, params.leadId, body.virtualNumberId);
    sendResponse(res, true, result, "Call initiated.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listLeadCalls = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateLeadIdParamSchema(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await callingService.listCallsForLead(req.user!, value.leadId);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listCallOutcomes = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await callingService.listCallOutcomes();
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const submitCallOutcome = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error: paramError, value: params } = validateCallIdParamSchema(req.params);
    if (paramError) {
      sendResponse(res, false, null, paramError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { error: bodyError, value: body } = validateSubmitCallOutcomeSchema(req.body);
    if (bodyError) {
      sendResponse(res, false, null, bodyError.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await callingService.submitCallOutcome(req.user!, params.id, body);
    sendResponse(res, true, result, "Call outcome saved.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

const TERMINAL_TRANSCRIPT_STATUSES = new Set(["COMPLETED", "EMPTY", "FAILED"]);
const TRANSCRIPT_STREAM_TIMEOUT_MS = 90_000; // covers the worker's retries (backoff across 3 attempts) plus normal transcribe time

function writeSseEvent(res: Response, payload: TranscriptEventPayload): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Pushes the transcript the moment it's ready instead of the browser tab polling for it - see
// calling.events.ts for how the pg-boss worker notifies this (same process, in-memory EventEmitter).
// Closes the connection itself once it has sent one terminal event (or after a timeout), so it never
// holds a connection open indefinitely.
export const streamCallTranscript = async (req: AuthRequest, res: Response): Promise<void> => {
  const { error, value: params } = validateCallIdParamSchema(req.params);
  if (error) {
    sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    return;
  }

  let transcript;
  try {
    transcript = await callingService.getTranscriptForCall(req.user!, params.id);
  } catch (err: any) {
    sendResponse(res, false, null, err.message, err.statusCode ?? STATUS_CODES.SERVER_ERROR);
    return;
  }

  res.writeHead(STATUS_CODES.OK, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  if (transcript && TERMINAL_TRANSCRIPT_STATUSES.has(transcript.status ?? "")) {
    writeSseEvent(res, { callId: params.id, status: transcript.status, transcriptText: transcript.transcriptText });
    res.end();
    return;
  }

  const eventName = transcriptEventName(params.id);
  const onEvent = (payload: TranscriptEventPayload) => {
    writeSseEvent(res, payload);
    cleanup();
    res.end();
  };
  const timer = setTimeout(() => {
    cleanup();
    res.end();
  }, TRANSCRIPT_STREAM_TIMEOUT_MS);
  function cleanup() {
    clearTimeout(timer);
    transcriptEvents.off(eventName, onEvent);
  }

  transcriptEvents.on(eventName, onEvent);
  req.on("close", cleanup);
};

export const receiveCallWebhook = async (req: Request, res: Response): Promise<void> => {
  if (!callingService.verifyWebhookSecret(req.headers as Record<string, unknown>, req.query as Record<string, unknown>)) {
    res.status(STATUS_CODES.UNAUTHORIZED).json({ success: false, message: "Invalid webhook secret" });
    return;
  }

  try {
    await callingService.handleCallWebhook(req.body);
    res.status(STATUS_CODES.OK).json({ success: true });
  } catch (error: any) {
    logger.error("[callerdesk] webhook processing failed", error);
    // Always ack so CallerDesk doesn't retry/disable delivery on our processing errors.
    res.status(STATUS_CODES.OK).json({ success: true });
  }
};
