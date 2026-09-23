import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import ProductsService from "./products.service.js";
import { validateListProductsQuery } from "./products.validators.js";

const productsService = new ProductsService();

export const listProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListProductsQuery(req.query);
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
