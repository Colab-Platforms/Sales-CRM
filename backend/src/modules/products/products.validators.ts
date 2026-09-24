import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { ListProductsQuery } from "./products.types.js";

const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listProductsQuerySchema = z.object({
  page: z.coerce.number({ error: "page must be a number" }).int().min(1).default(1),
  pageSize: z.coerce.number({ error: "pageSize must be a number" }).int().min(1).max(100, "pageSize must be between 1 and 100").default(20),
  search: optional(z.string().trim().max(100)),
});

export const validateListProductsQuery = (query: unknown) => validateSchema<ListProductsQuery>(listProductsQuerySchema, query);
