import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

const setEnabledSchema = z.object({
  enabled: z.boolean({ error: "enabled must be true or false" }),
});

export interface SetAutoAssignEnabledBody {
  enabled: boolean;
}

export const validateSetAutoAssignEnabled = (body: unknown) => validateSchema<SetAutoAssignEnabledBody>(setEnabledSchema, body);
