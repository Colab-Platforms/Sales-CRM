import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

const orderParams = z.object({ orderId: z.uuid({ error: "Invalid order id" }) });
const paymentParams = z.object({ paymentId: z.uuid({ error: "Invalid payment id" }) });
// templateId is now optional: when the conversation is on Meta and its 24-hour service window is
// open, the link is sent as free text and no template is needed at all (see sendPaymentLinkWhatsApp).
const sendBody = z.object({ templateId: z.uuid({ error: "Invalid template id" }).optional() });

export const validateOrderParams = (params: unknown) => validateSchema<{ orderId: string }>(orderParams, params);
export const validatePaymentParams = (params: unknown) => validateSchema<{ paymentId: string }>(paymentParams, params);
export const validateSendBody = (body: unknown) => validateSchema<{ templateId?: string }>(sendBody, body);
