import { prisma } from "@/lib/prisma.js";
import { comparePassword } from "@/lib/password.js";
import { signToken } from "@/lib/jwt.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { UserStatus } from "../../../generated/prisma/enums.js";
import type { LoginBody } from "./auth.types.js";

function toPublicUser(user: { id: string; name: string; email: string; role: string; status: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status };
}

class AuthService {
  async login(data: LoginBody) {
    const user = await prisma.user.findUnique({ where: { email: data.email } });

    if (!user || !user.passwordHash) {
      throw new ApiError("Invalid email or password", STATUS_CODES.UNAUTHORIZED);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ApiError("Account is inactive", STATUS_CODES.FORBIDDEN);
    }

    const isPasswordValid = await comparePassword(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new ApiError("Invalid email or password", STATUS_CODES.UNAUTHORIZED);
    }

    const accessToken = signToken({ sub: user.id, role: user.role, email: user.email });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return { user: toPublicUser(user), accessToken };
  }

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new ApiError("User not found", STATUS_CODES.NOT_FOUND);
    }
    return toPublicUser(user);
  }
}

export default AuthService;
