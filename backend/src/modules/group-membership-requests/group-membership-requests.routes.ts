import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  approveMembershipRequest,
  createMembershipRequest,
  getPendingMembershipRequestCount,
  listMembershipRequests,
  rejectMembershipRequest,
} from "./group-membership-requests.controller.js";

const router = Router();

router.use(requireAuth);

// Raising a request: MANAGER only (their own groups/direct reports, enforced in the service).
router.post("/", requireRole(Role.MANAGER), createMembershipRequest);
// Listing: MANAGER sees their own requests; ADMIN/HR see every request (the approval queue).
router.get("/", requireRole(Role.MANAGER, Role.ADMIN, Role.HR), listMembershipRequests);
// Reviewing: ADMIN/HR only.
router.get("/pending-count", requireRole(Role.ADMIN, Role.HR), getPendingMembershipRequestCount);
router.post("/:id/approve", requireRole(Role.ADMIN, Role.HR), approveMembershipRequest);
router.post("/:id/reject", requireRole(Role.ADMIN, Role.HR), rejectMembershipRequest);

export default router;
