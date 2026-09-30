import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";

// The two auto-assignment toggles behind LeadService.autoAssignAbandonedLead: an admin-only switch
// for the manager stage (at most one row, same "missing = disabled" convention as
// WhatsAppAutomationConfig) and one row per manager for the salesperson stage, since each manager
// controls their own team's toggle independently.

export interface AutoAssignConfigResult {
  enabled: boolean;
}

class AbandonmentAutoAssignService {
  private readonly db = prisma;

  async getManagerConfig(): Promise<AutoAssignConfigResult> {
    const row = await this.db.managerAutoAssignConfig.findFirst({ select: { enabled: true } });
    return { enabled: row?.enabled ?? false };
  }

  async setManagerConfig(user: AuthUser, enabled: boolean): Promise<AutoAssignConfigResult> {
    const existing = await this.db.managerAutoAssignConfig.findFirst({ select: { id: true } });
    const row = existing
      ? await this.db.managerAutoAssignConfig.update({ where: { id: existing.id }, data: { enabled, updatedById: user.id } })
      : await this.db.managerAutoAssignConfig.create({ data: { enabled, updatedById: user.id } });
    return { enabled: row.enabled };
  }

  async getSalespersonConfig(managerId: string): Promise<AutoAssignConfigResult> {
    const row = await this.db.salespersonAutoAssignConfig.findUnique({ where: { managerId }, select: { enabled: true } });
    return { enabled: row?.enabled ?? false };
  }

  async setSalespersonConfig(managerId: string, enabled: boolean): Promise<AutoAssignConfigResult> {
    const row = await this.db.salespersonAutoAssignConfig.upsert({
      where: { managerId },
      update: { enabled },
      create: { managerId, enabled },
    });
    return { enabled: row.enabled };
  }
}

export default AbandonmentAutoAssignService;
