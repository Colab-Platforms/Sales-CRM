import { Router } from "express";
import { login, me, getProfile, refresh, logout } from "./auth.controller.js";
import { requireAuth } from "@/middlewares/auth.js";

const router = Router();

router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/me", requireAuth, me);
router.get("/profile", requireAuth, getProfile);

export default router;
