import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/password.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { CreateManagerBody, UpdateManagerBody } from "./admin.types.js";

function toPublicUser(user: { id: string; name: string; email: string; phone: string | null; role: string; status: string }) {
  return { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, status: user.status };
}

class AdminService {
  async createManager(data: CreateManagerBody) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new ApiError("Email already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const manager = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        passwordHash,
        role: Role.MANAGER,
        status: UserStatus.ACTIVE,
      },
    });

    return toPublicUser(manager);
  }

  async listManagers() {
    const managers = await prisma.user.findMany({
      where: { role: Role.MANAGER },
      orderBy: { createdAt: "desc" },
    });
    return managers.map(toPublicUser);
  }

  private async getManagerOrThrow(id: string) {
    const manager = await prisma.user.findUnique({ where: { id } });
    if (!manager || manager.role !== Role.MANAGER) {
      throw new ApiError("Manager not found", STATUS_CODES.NOT_FOUND);
    }
    return manager;
  }

  async getManagerById(id: string) {
    const manager = await this.getManagerOrThrow(id);
    return toPublicUser(manager);
  }

  async updateManager(id: string, data: UpdateManagerBody) {
    await this.getManagerOrThrow(id);

    const manager = await prisma.user.update({
      where: { id },
      data: {
        name: data.name,
        phone: data.phone,
        status: data.status,
      },
    });

    return toPublicUser(manager);
  }

  async deactivateManager(id: string) {
    await this.getManagerOrThrow(id);

    const manager = await prisma.user.update({
      where: { id },
      data: { status: UserStatus.INACTIVE },
    });

    return toPublicUser(manager);
  }
}

export default AdminService;
