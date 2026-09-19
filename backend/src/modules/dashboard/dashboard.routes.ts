import { Router } from "express";
import { getDashboard } from "./dashboard.controller.js";
import { requireAuth } from "@/middlewares/auth.js";

const router = Router();

router.get("/", requireAuth, getDashboard);

export default router;
