import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { ListShipmentsQuery } from "./shiprocket.types.js";

const orderParams = z.object({ orderId: z.uuid({ error: "Invalid order id" }) });
const shipmentParams = z.object({ shipmentId: z.uuid({ error: "Invalid shipment id" }) });

// The frontend omits empty filters, but treat `?status=` as "not set" too - same convention as orders.validators.ts.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1, "pageSize must be between 1 and 100").max(100, "pageSize must be between 1 and 100").default(25),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    status: optional(z.enum(ShipmentStatus, { error: "Invalid shipment status" })),
    courier: optional(z.string().trim().max(150, "courier must be 150 characters or fewer")),
    paymentMode: optional(z.enum(["COD", "PREPAID"], { error: "paymentMode must be COD or PREPAID" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { error: "dateFrom must not be after dateTo" });

export const validateListQuery = (query: unknown) => validateSchema<ListShipmentsQuery>(listQuerySchema, query);

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
