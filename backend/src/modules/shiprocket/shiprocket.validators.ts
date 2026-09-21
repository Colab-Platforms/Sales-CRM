import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

const orderParams = z.object({ orderId: z.uuid({ error: "Invalid order id" }) });
const shipmentParams = z.object({ shipmentId: z.uuid({ error: "Invalid shipment id" }) });

// Parcel size and weight are not stored on a CRM order, so the person creating the shipment supplies them.
const createBody = z.object({
  weight: z.number({ error: "Weight (kg) is required" }).min(0.01, "Weight must be at least 0.01 kg").max(100, "Weight must be at most 100 kg"),
  length: z.number({ error: "Length (cm) is required" }).min(0.5, "Length must be at least 0.5 cm").max(300, "Length must be at most 300 cm"),
  breadth: z.number({ error: "Breadth (cm) is required" }).min(0.5, "Breadth must be at least 0.5 cm").max(300, "Breadth must be at most 300 cm"),
  height: z.number({ error: "Height (cm) is required" }).min(0.5, "Height must be at least 0.5 cm").max(300, "Height must be at most 300 cm"),
  acknowledgeUnconfirmed: z.boolean().optional(),
});

const assignBody = z.object({ courierId: z.number({ error: "courierId is required" }).int("courierId must be a whole number").positive("courierId must be positive") });

export const validateOrderParams = (params: unknown) => validateSchema<{ orderId: string }>(orderParams, params);
export const validateShipmentParams = (params: unknown) => validateSchema<{ shipmentId: string }>(shipmentParams, params);
export const validateCreateBody = (body: unknown) => validateSchema<z.infer<typeof createBody>>(createBody, body);
export const validateAssignBody = (body: unknown) => validateSchema<{ courierId: number }>(assignBody, body);
