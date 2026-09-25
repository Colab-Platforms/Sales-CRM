import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { completeTask, listMyFollowUps, snoozeTask } from "./tasks.controller.js";

const router = Router();

router.use(requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON));

router.get("/follow-ups", listMyFollowUps);
router.patch("/:id/complete", completeTask);
router.patch("/:id/snooze", snoozeTask);

export default router;
