import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
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

/** Deletion errors for the user: an expected refusal (ApiError: 4xx with its own text) is shown as is; anything else (a database error) is logged in full on the server and the screen gets a plain message, never raw query text. */
function deletionFailure(res: Response, error: any, what: string): void {
  if (error?.statusCode && error.statusCode < 500) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode);
    return;
  }
  logger.error(`${what} failed: ${error?.name ?? "Error"} ${error?.code ?? ""} ${String(error?.message ?? "").replace(/\s+/g, " ").slice(0, 600)}`);
  sendResponse(res, false, null, `${what} could not be completed because of an internal error. Each batch is all-or-nothing, so no lead was left half-deleted; leads already deleted in earlier batches stay deleted. You can run it again to continue.`, STATUS_CODES.SERVER_ERROR);
}

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
    deletionFailure(res, error, "Deleting the lead");
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

    if (req.user!.role === "ADMIN") {
      // an Admin assigns ONE salesperson directly (not through a manager's team, and without touching the manager)
      if (value.method !== "MANUAL" || !value.salespersonId) {
        sendResponse(res, false, null, "Choose one salesperson to assign the leads to", STATUS_CODES.BAD_REQUEST);
        return;
      }
      const result = value.filter
        ? await leadService.bulkAssignSalespersonsAsAdminByFilter(req.user!, value.filter, value.salespersonId)
        : await leadService.bulkAssignSalespersonsAsAdmin(req.user!.id, { leadIds: value.leadIds!, salespersonId: value.salespersonId });
      sendResponse(res, true, result, "Leads assigned to salesperson successfully.", STATUS_CODES.OK);
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
    deletionFailure(res, error, "Counting the leads");
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
    deletionFailure(res, error, "Deleting the leads");
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

