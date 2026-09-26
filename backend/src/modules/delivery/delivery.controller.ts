import type { Response } from "express";
import { z } from "zod";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { validateSchema } from "@/utils/validate.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { lookupPincode, PINCODE_PATTERN } from "./delivery.pincode.js";
import { checkServiceability } from "./delivery.serviceability.js";

const pincodeParams = z.object({ pincode: z.string().regex(PINCODE_PATTERN, "Please enter a valid 6-digit Indian pincode.") });
const serviceabilityQuery = z.object({
  pincode: z.string().regex(PINCODE_PATTERN, "Please enter a valid 6-digit Indian pincode."),
  cod: z.enum(["0", "1"], { error: "cod must be 0 or 1" }),
  weight: z.coerce.number({ error: "weight must be a number" }).positive("weight must be greater than 0").max(100, "weight must be 100 kg or less"),
});

// Open to every signed-in user who can create an order (the form runs these checks while a salesperson types). Both
// answers are non-sensitive lookups; nothing here reveals credentials or customer data.
export const getPincode = async (req: AuthRequest, res: Response): Promise<void> => {
  const { error, value } = validateSchema(pincodeParams, req.params);
  if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
  sendResponse(res, true, await lookupPincode(value.pincode), "OK", STATUS_CODES.OK);
};

export const getServiceability = async (req: AuthRequest, res: Response): Promise<void> => {
  const { error, value } = validateSchema(serviceabilityQuery, req.query);
  if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
  sendResponse(res, true, await checkServiceability({ pincode: value.pincode, cod: value.cod === "1", weightKg: value.weight }), "OK", STATUS_CODES.OK);
};
