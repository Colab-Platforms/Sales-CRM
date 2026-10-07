import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { ListProductsQuery } from "./products.types.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listProductsQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1).default(1),
  pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20),
  search: optional(z.string().trim().max(100)),
});

// null clears the recorded weight. A weight is a real positive number of kilograms: 0 and negatives are rejected, never coerced.
const weightBodySchema = z.object({
  weightKg: z.union([z.null(), z.coerce.number({ error: "Weight must be a number" }).gt(0, "Weight must be greater than 0").max(100, "Weight must be 100 kg or less")]),
});
const idParamSchema = z.object({ id: z.uuid({ error: "Invalid id" }) });

export const validateWeightBody = (body: unknown) => validateSchema<{ weightKg: number | null }>(weightBodySchema, body);
export const validateIdParam = (params: unknown) => validateSchema<{ id: string }>(idParamSchema, params);
export const validateListProductsQuery = (query: unknown) => validateSchema<ListProductsQuery>(listProductsQuerySchema, query);
