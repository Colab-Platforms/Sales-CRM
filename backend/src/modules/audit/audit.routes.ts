import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { listAudit } from "./audit.controller.js";

const router = Router();

router.get("/", requireAuth, listAudit);

export default router;
