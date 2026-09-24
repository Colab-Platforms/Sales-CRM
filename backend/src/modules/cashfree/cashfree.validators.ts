import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

const orderParams = z.object({ orderId: z.uuid({ error: "Invalid order id" }) });
const paymentParams = z.object({ paymentId: z.uuid({ error: "Invalid payment id" }) });
const sendBody = z.object({ templateId: z.uuid({ error: "Invalid template id" }) });

export const validateOrderParams = (params: unknown) => validateSchema<{ orderId: string }>(orderParams, params);
export const validatePaymentParams = (params: unknown) => validateSchema<{ paymentId: string }>(paymentParams, params);
export const validateSendBody = (body: unknown) => validateSchema<{ templateId: string }>(sendBody, body);
