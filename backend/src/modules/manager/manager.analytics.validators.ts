import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { todayString } from "../attendance/attendance.calc.js";
import type { AnalyticsFilters } from "./manager.analytics.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const schema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    salespersonId: z.string().uuid().optional(),
    callStatus: z.enum(["ALL", "CONNECTED", "NOT_CONNECTED", "FAILED"]).default("ALL"),
    leadStatus: z.enum(["ALL", "NOT_CONTACTED", "CONTACTED", "INTERESTED", "CONVERTED"]).default("ALL"),
    paymentMode: z.enum(["ALL", "COD", "PREPAID"]).default("ALL"),
    // Only the sold statuses: cancelled/returned/refunded orders are never part of Sales & Revenue.
    orderStatus: z.enum(["ALL", "CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]).default("ALL"),
    tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(REPORT_TZ_OFFSET_MINUTES),
  })
  .transform((q): AnalyticsFilters => {
    // Report days are business days in India time (IST) for every viewer, so a browser's own
    // timezone can never shift orders or calls onto a different day. The client value is ignored.
    const tzOffsetMinutes = REPORT_TZ_OFFSET_MINUTES;
    const today = todayString(new Date(), tzOffsetMinutes);
    const to = q.to ?? today;
    return { ...q, tzOffsetMinutes, from: q.from ?? to, to };
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to" });

export const validateAnalyticsQuery = (query: unknown) => validateSchema<AnalyticsFilters>(schema, query);
