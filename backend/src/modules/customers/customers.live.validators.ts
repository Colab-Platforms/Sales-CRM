import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { LiveCustomersQuery } from "./customers.live.types.js";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const liveCustomersQuerySchema = z.object({
  after: optional(z.string().trim().max(500, "after must be a valid cursor")),
  // Same 25-50 "small initial page, never the whole base" bound as the live Orders endpoint.
  first: z.coerce.number({ error: "first must be a number" }).int().min(1).max(50).default(25),
  search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
});

export const validateLiveCustomersQuery = (query: unknown) => validateSchema<LiveCustomersQuery>(liveCustomersQuerySchema, query);
