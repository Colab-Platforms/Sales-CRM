import jwt, { type SignOptions } from "jsonwebtoken";
import { Role } from "../../generated/prisma/enums.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

export interface JwtPayload {
  sub: string;
  role: Role;
  email: string;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

const JWT_SECRET = getSecret();
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? "1d") as SignOptions["expiresIn"];

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    throw new ApiError("Invalid or expired token", STATUS_CODES.UNAUTHORIZED);
  }
}
