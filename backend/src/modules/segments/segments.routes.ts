import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthRequest } from "@/middlewares/auth.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { validateSchema } from "@/utils/validate.js";
import { Role } from "../../../generated/prisma/enums.js";
import { segmentService } from "./segments.service.js";

// /api/segments. Everyone who works leads may READ the active segments (they are the tags and filters); only an ADMIN creates, renames, recolours, archives or deletes one.

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour must look like #1a2b3c");
const name = z.string().trim().min(1, "Name is required").max(100, "Name is too long");
const createSchema = z.object({ name, color: color.optional() }).strict();
const updateSchema = z.object({ name: name.optional(), color: color.optional(), isActive: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
const idSchema = z.string().guid("Invalid segment id");

const router = Router();
router.use(requireAuth);

const handle = (run: (req: AuthRequest) => Promise<{ data: unknown; message: string; status?: number }>) => async (req: AuthRequest, res: Response) => {
  try {
    const r = await run(req);
    sendResponse(res, true, r.data, r.message, r.status ?? STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
const bad = (message: string) => Object.assign(new Error(message), { statusCode: STATUS_CODES.BAD_REQUEST });
const idOf = (req: AuthRequest): string => {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) throw bad("Invalid segment id");
  return parsed.data;
};

router.get(
  "/",
  requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON),
  handle(async (req) => ({
    data: await segmentService.list(req.user!, { includeInactive: req.query.includeInactive === "true", withCounts: req.query.counts === "true" }),
    message: "OK",
  })),
);

router.post(
  "/",
  requireRole(Role.ADMIN),
  handle(async (req) => {
    const { error, value } = validateSchema(createSchema, req.body);
    if (error) throw bad(error.message);
    return { data: await segmentService.create(req.user!, value), message: "Segment created.", status: STATUS_CODES.CREATED };
  }),
);

router.get("/:id", requireRole(Role.ADMIN, Role.MANAGER), handle(async (req) => ({ data: await segmentService.stats(req.user!, idOf(req)), message: "OK" })));

router.patch(
  "/:id",
  requireRole(Role.ADMIN),
  handle(async (req) => {
    const { error, value } = validateSchema(updateSchema, req.body);
    if (error) throw bad(error.message);
    return { data: await segmentService.update(idOf(req), value), message: "Segment updated." };
  }),
);

router.delete("/:id", requireRole(Role.ADMIN), handle(async (req) => ({ data: await segmentService.remove(idOf(req)), message: "Segment deleted." })));

export default router;
