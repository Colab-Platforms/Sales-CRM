import type { Request, Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import AuthService from "./auth.service.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { validateLoginSchema } from "./auth.validators.js";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "@/lib/refreshToken.js";
import { ApiError } from "@/utils/apiError.js";

const authService = new AuthService();

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { error, value } = validateLoginSchema(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const { refreshToken, ...result } = await authService.login(value, req.headers["user-agent"]);
    // The refresh token travels only as an httpOnly cookie, never in the body where page JS could read it.
    setRefreshCookie(res, refreshToken!);
    sendResponse(res, true, result, "Logged in successfully.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Refresh and logout are cookie-authenticated, so they demand a custom header: a cross-site form post can't send one, and a
// cross-origin fetch that does must pass the CORS preflight (which only allows our own origins).
function requireAjaxHeader(req: Request): void {
  if (!req.headers["x-requested-with"]) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
}

export const refresh = async (req: Request, res: Response): Promise<void> => {
  try {
    requireAjaxHeader(req);
    const token = readRefreshCookie(req);
    if (!token) throw new ApiError("Session expired. Please sign in again.", STATUS_CODES.UNAUTHORIZED);
    const { refreshToken, ...result } = await authService.refreshSession(token, req.headers["user-agent"]);
    if (refreshToken) setRefreshCookie(res, refreshToken);
    sendResponse(res, true, result, "Session refreshed.", STATUS_CODES.OK);
  } catch (error: any) {
    if (error.statusCode === STATUS_CODES.UNAUTHORIZED) clearRefreshCookie(res);
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    requireAjaxHeader(req);
    await authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    sendResponse(res, true, null, "Logged out.", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const me = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await authService.getCurrentUser(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await authService.getProfile(req.user!.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
