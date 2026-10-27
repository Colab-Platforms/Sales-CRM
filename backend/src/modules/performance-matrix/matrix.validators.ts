import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import type { MatrixQuery } from "./matrix.service.js";

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  salespersonId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
});

export const validateMatrixQuery = (q: unknown) => validateSchema<MatrixQuery>(querySchema, q);
