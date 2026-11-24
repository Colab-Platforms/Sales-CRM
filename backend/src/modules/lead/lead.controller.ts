import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import LeadService from "./lead.service.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import {
  validateCreateLeadSchema,
  validateUpdateLeadSchema,
  validateListLeadsQuerySchema,
  validateBulkAssignManagerSchema,
  validateBulkAssignSalespersonSchema,
  validateBulkUpdateStatusSchema,
  validateImportPreviewSchema,
  validateBulkDeleteSchema,
  validateBulkDeletePreviewSchema,
} from "./lead.validators.js";

const leadService = new LeadService();

export const listLeads = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListLeadsQuerySchema(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await leadService.listLeads(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getBucketSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await leadService.getBucketSummary(req.user!.id, req.query.kind === "ABANDONED" ? "ABANDONED" : "LEAD");
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getLead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await leadService.getLeadById(req.user!, req.params.id as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const createLead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateLeadSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await leadService.createLead(req.user!, value);
    sendResponse(res, true, result, "Lead created successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateLead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateUpdateLeadSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await leadService.updateLead(req.user!, req.params.id as string, value);
    sendResponse(res, true, result, "Lead updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const deleteLead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await leadService.deleteLead(req.user!, req.params.id as string);
    sendResponse(res, true, result, "Lead deleted successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getAssignmentHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await leadService.getAssignmentHistory(req.user!, req.params.id as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const bulkAssignManager = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkAssignManagerSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { filter, leadIds, ...rest } = value;
    const result = filter ? await leadService.bulkAssignManagersByFilter(req.user!, filter, rest) : await leadService.bulkAssignManagers(req.user!.id, { ...rest, leadIds: leadIds! });
    sendResponse(res, true, result, "Leads assigned to manager successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const bulkAssignSalesperson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkAssignSalespersonSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { filter, leadIds, ...rest } = value;
    const result = filter ? await leadService.bulkAssignSalespersonsByFilter(req.user!, filter, rest) : await leadService.bulkAssignSalespersons(req.user!.id, { ...rest, leadIds: leadIds! });
    sendResponse(res, true, result, "Leads assigned to salesperson successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const previewBulkDelete = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkDeletePreviewSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await leadService.previewBulkDelete(req.user!, value), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const bulkDeleteLeads = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkDeleteSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const { confirm: _confirm, confirmText: _confirmText, ...rest } = value;
    sendResponse(res, true, await leadService.bulkDeleteLeads(req.user!, rest), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const bulkUpdateStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateBulkUpdateStatusSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await leadService.bulkUpdateStatus(req.user!, value);
    sendResponse(res, true, result, "Lead status updated successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const previewImport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      sendResponse(res, false, null, "CSV file is required", STATUS_CODES.BAD_REQUEST);
      return;
    }

    let columnMapping: Record<string, string>;
    try {
      columnMapping = JSON.parse(req.body.columnMapping ?? "{}");
    } catch {
      sendResponse(res, false, null, "columnMapping must be valid JSON", STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { error, value } = validateImportPreviewSchema({ columnMapping });
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await leadService.previewImport(req.user!, req.file, value.columnMapping);
    sendResponse(res, true, result, "Import previewed successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const confirmImport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await leadService.confirmImport(req.user!, req.params.batchId as string);
    sendResponse(res, true, result, "Leads imported successfully.", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getImportBatch = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await leadService.getImportBatch(req.user!, req.params.batchId as string);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

