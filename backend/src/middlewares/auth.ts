import { Request, Response, NextFunction } from "express";
import { verifyToken } from "@/lib/jwt.js";
import { Role } from "../../generated/prisma/enums.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new ApiError("Authentication required", STATUS_CODES.UNAUTHORIZED));
    return;
  }

  const token = header.slice(7);
  const payload = verifyToken(token);
  req.user = { id: payload.sub, role: payload.role, email: payload.email };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new ApiError("Forbidden", STATUS_CODES.FORBIDDEN));
      return;
    }
    next();
  };
}
