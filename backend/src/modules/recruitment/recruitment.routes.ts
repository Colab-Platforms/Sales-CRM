import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { csvUpload } from "@/middlewares/upload.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  assignApplications,
  confirmImport,
  createApplication,
  createJob,
  exportJobApplications,
  getApplication,
  getDistribution,
  getJob,
  listApplications,
  listJobApplications,
  listJobs,
  previewImport,
  updateApplication,
  updateJob,
} from "./recruitment.controller.js";

const router = Router();

// Mounted at /api/recruitment. HR (and admin) own jobs, imports, assignment and export; a RECRUITER only
// works the applications assigned to them (RecruitmentService scopes every read and write by recruiterId).
router.use(requireAuth);

const staff = requireRole(Role.ADMIN, Role.HR);
const staffOrRecruiter = requireRole(Role.ADMIN, Role.HR, Role.RECRUITER);

router.get("/jobs", staffOrRecruiter, listJobs);
router.post("/jobs", staff, createJob);
router.get("/jobs/:id", staff, getJob);
router.patch("/jobs/:id", staff, updateJob);
router.get("/jobs/:id/applications", staff, listJobApplications);
router.get("/jobs/:id/applications/export", staff, exportJobApplications);
router.post("/jobs/:id/applications/import/preview", staff, csvUpload.single("file"), previewImport);
router.post("/applications/import/:batchId/confirm", staff, confirmImport);

router.post("/applications/assign", staff, assignApplications);
router.get("/distribution", staff, getDistribution);

router.post("/applications", staffOrRecruiter, createApplication);
router.get("/applications", staffOrRecruiter, listApplications);
router.get("/applications/:id", staffOrRecruiter, getApplication);
router.patch("/applications/:id", staffOrRecruiter, updateApplication);

export default router;
