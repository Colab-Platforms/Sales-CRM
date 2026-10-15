import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { ApplicationStatus, JobStatus } from "../../../generated/prisma/enums.js";

const uuid = z.string().uuid();

const createJobSchema = z.object({
  title: z.string().trim().min(2, "Title must be at least 2 characters").max(200),
  department: z.string().trim().max(150).optional(),
  location: z.string().trim().max(150).optional(),
});

const updateJobSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    department: z.string().trim().max(150).optional(),
    location: z.string().trim().max(150).optional(),
    status: z.nativeEnum(JobStatus).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

export const IMPORT_FIELDS = ["name", "mobile", "email", "resumeUrl"] as const;
const importPreviewSchema = z.object({
  columnMapping: z
    .record(z.string(), z.enum(IMPORT_FIELDS))
    .refine((m) => Object.values(m).includes("name"), { message: "Map a column to name" })
    .refine((m) => Object.values(m).includes("mobile"), { message: "Map a column to mobile" }),
});

const assignSchema = z.object({
  applicationIds: z.array(uuid).min(1, "Select at least one application").max(2000),
  // One id = manual assignment; several = spread the applications evenly across them.
  recruiterIds: z.array(uuid).min(1, "Select at least one recruiter").max(100),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.nativeEnum(ApplicationStatus).optional(),
  recruiterId: z.union([uuid, z.literal("unassigned")]).optional(),
  jobId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
});

const updateApplicationSchema = z
  .object({
    // Recruiters call manually, so they only record the screening outcome.
    status: z.enum([ApplicationStatus.SCREENED, ApplicationStatus.SHORTLISTED, ApplicationStatus.HIRED, ApplicationStatus.REJECTED]).optional(),
    notes: z.string().max(5000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "No fields to update" });

const createApplicationSchema = z.object({
  jobId: uuid,
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(200),
  mobile: z.string().trim().min(8, "Enter a valid mobile number").max(30),
  email: z.string().trim().max(255).optional(),
  resumeUrl: z.string().trim().max(2000).optional(),
  notes: z.string().max(5000).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const validateCreateJob = (b: unknown) => validateSchema<z.infer<typeof createJobSchema>>(createJobSchema, b);
export const validateUpdateJob = (b: unknown) => validateSchema<z.infer<typeof updateJobSchema>>(updateJobSchema, b);
export const validateImportPreview = (b: unknown) =>
  validateSchema<{ columnMapping: Record<string, (typeof IMPORT_FIELDS)[number]> }>(importPreviewSchema, b);
export const validateAssign = (b: unknown) => validateSchema<z.infer<typeof assignSchema>>(assignSchema, b);
export const validateListQuery = (q: unknown) => validateSchema<ListQuery>(listQuerySchema, q);
export const validateUpdateApplication = (b: unknown) =>
  validateSchema<z.infer<typeof updateApplicationSchema>>(updateApplicationSchema, b);
export const validateCreateApplication = (b: unknown) =>
  validateSchema<z.infer<typeof createApplicationSchema>>(createApplicationSchema, b);
export const validateIdParam = (p: unknown) => validateSchema<{ id: string }>(z.object({ id: uuid }), p);
