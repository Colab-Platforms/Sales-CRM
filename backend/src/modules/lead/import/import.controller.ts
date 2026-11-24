import type { Response } from "express";
import { z } from "zod";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { validateSchema } from "@/utils/validate.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { leadImportService } from "./import.service.js";

const guid = z.string().guid("Invalid id");
const mappingSchema = z.object({ mapping: z.record(z.string().max(200), z.string().max(40)).optional(), segmentId: guid.nullable().optional() }).strict();
const startSchema = z.object({ segmentId: guid.nullable().optional() }).strict();

const fail = (res: Response, error: any) => sendResponse(res, false, error?.data ?? null, error?.message ?? "Error", error?.statusCode ?? STATUS_CODES.SERVER_ERROR);
const batchId = (req: AuthRequest): string => {
  const parsed = guid.safeParse(req.params.batchId);
  if (!parsed.success) throw Object.assign(new Error("Invalid import id"), { statusCode: STATUS_CODES.BAD_REQUEST });
  return parsed.data;
};

export const analyzeImportFile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      sendResponse(res, false, null, "A file is required", STATUS_CODES.BAD_REQUEST);
      return;
    }
    const seg = req.body?.segmentId ? guid.safeParse(req.body.segmentId) : null;
    if (seg && !seg.success) {
      sendResponse(res, false, null, "Invalid segment", STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await leadImportService.analyze(req.user!, req.file, seg?.data), "File read.", STATUS_CODES.OK);
  } catch (error) {
    fail(res, error);
  }
};

export const updateImportMapping = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema(mappingSchema, req.body ?? {});
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await leadImportService.updateMapping(req.user!, batchId(req), value), "Preview updated.", STATUS_CODES.OK);
  } catch (error) {
    fail(res, error);
  }
};

export const startImportFile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema(startSchema, req.body ?? {});
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await leadImportService.start(req.user!, batchId(req), value), "Import started.", 202);
  } catch (error) {
    fail(res, error);
  }
};

export const getImportProgress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await leadImportService.progress(req.user!, batchId(req)), "OK", STATUS_CODES.OK);
  } catch (error) {
    fail(res, error);
  }
};

export const getImportReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const kind = req.query.kind === "duplicates" ? "duplicates" : "failed";
    await leadImportService.streamReport(req.user!, batchId(req), kind, res);
  } catch (error) {
    if (res.headersSent) res.end();
    else fail(res, error);
  }
};
