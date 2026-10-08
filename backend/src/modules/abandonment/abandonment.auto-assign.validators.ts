import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

const setEnabledSchema = z.object({
  enabled: z.boolean({ error: "enabled must be true or false" }),
});

export interface SetAutoAssignEnabledBody {
  enabled: boolean;
}

export const validateSetAutoAssignEnabled = (body: unknown) => validateSchema<SetAutoAssignEnabledBody>(setEnabledSchema, body);

// Manager stage only: `managerIds` selects which managers participate. Required (and must be
// non-empty) when turning auto-assign on - there's no point enabling it with nobody selected.
// Omitted when turning it off, so the previous selection survives for next time.
const setManagerConfigSchema = z
  .object({
    enabled: z.boolean({ error: "enabled must be true or false" }),
    managerIds: z.array(z.string().uuid("managerIds must be valid ids")).optional(),
  })
  .refine((v) => !v.enabled || (v.managerIds && v.managerIds.length > 0), {
    message: "Select at least one manager to turn auto-assignment on.",
    path: ["managerIds"],
  });

export interface SetManagerAutoAssignConfigBody {
  enabled: boolean;
  managerIds?: string[];
}

export const validateSetManagerAutoAssignConfig = (body: unknown) => validateSchema<SetManagerAutoAssignConfigBody>(setManagerConfigSchema, body);
