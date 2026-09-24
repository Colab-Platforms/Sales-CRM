import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/password.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type {
  CreateManagerBody,
  CreateSalespersonBody,
  UpdateManagerBody,
  UpdateSalespersonBody,
} from "./admin.types.js";

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

  // Admin picks the reporting manager up front — from that point on, only that
  // manager (not every manager) can see this salesperson or add them to a team.
  async createSalesperson(adminId: string, data: CreateSalespersonBody) {
    const manager = await this.getManagerOrThrow(data.reportingManagerId);
    if (manager.status !== UserStatus.ACTIVE) {
      throw new ApiError("Reporting manager is not active", STATUS_CODES.BAD_REQUEST);
    }

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new ApiError("Email already in use", STATUS_CODES.CONFLICT);
    }

    const passwordHash = await hashPassword(data.password);

    const salesperson = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        passwordHash,
        role: Role.SALESPERSON,
        status: UserStatus.ACTIVE,
        reportingManagerId: data.reportingManagerId,
        createdById: adminId,
      },
    });

    return toPublicUser(salesperson);
  }

  async listSalespersons() {
    const salespersons = await prisma.user.findMany({
      where: { role: Role.SALESPERSON },
      include: { reportingManager: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    return salespersons.map((sp) => ({ ...toPublicUser(sp), reportingManager: sp.reportingManager }));
  }

  private async getSalespersonOrThrow(id: string) {
    const salesperson = await prisma.user.findUnique({ where: { id } });
    if (!salesperson || salesperson.role !== Role.SALESPERSON) {
      throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    }
    return salesperson;
  }

  async updateSalesperson(id: string, data: UpdateSalespersonBody) {
    const existing = await this.getSalespersonOrThrow(id);
    const isReassignment =
      data.reportingManagerId !== undefined && data.reportingManagerId !== existing.reportingManagerId;

    if (isReassignment) {
      const manager = await this.getManagerOrThrow(data.reportingManagerId as string);
      if (manager.status !== UserStatus.ACTIVE) {
        throw new ApiError("Reporting manager is not active", STATUS_CODES.BAD_REQUEST);
      }
    }

    const salesperson = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          name: data.name,
          phone: data.phone,
          status: data.status,
          reportingManagerId: data.reportingManagerId,
        },
        include: { reportingManager: { select: { id: true, name: true, email: true } } },
      });

      if (isReassignment) {
        // Old manager loses visibility entirely — including any group they'd
        // already placed this salesperson in.
        await tx.groupMember.updateMany({
          where: { userId: id, isActive: true, group: { managerId: { not: data.reportingManagerId } } },
          data: { isActive: false },
        });
      }

      return updated;
    });

    return { ...toPublicUser(salesperson), reportingManager: salesperson.reportingManager };
  }
}

export default AdminService;
