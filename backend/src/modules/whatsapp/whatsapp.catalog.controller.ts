import { Response } from "express";
import { z } from "zod";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { validateSchema } from "@/utils/validate.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import ProductsService from "../products/products.service.js";

const productsService = new ProductsService();

// Thin wrapper over the existing, general-purpose ProductsService.listProducts - no second catalog
// implementation. Exists only because the WhatsApp Inbox needs this under its own path for the
// frontend's catalog-search UI (Phase 3); the underlying data/search logic is entirely reused.
const searchSchema = z.object({ search: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) });

export const searchCatalog = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema(searchSchema, req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await productsService.listProducts(value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
