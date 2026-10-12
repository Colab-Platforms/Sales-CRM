import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";

// The two auto-assignment toggles behind LeadService.autoAssignAbandonedLead: an admin-only switch
// for the manager stage (at most one row, same "missing = disabled" convention as
// WhatsAppAutomationConfig) and one row per manager for the salesperson stage, since each manager
// controls their own team's toggle independently.

export interface AutoAssignConfigResult {
  enabled: boolean;
}

// The manager stage also carries which managers participate (ManagerAutoAssignTarget) - the master
// `enabled` switch is pointless on its own if nobody is selected, so the two always travel together.
export interface ManagerAutoAssignConfigResult extends AutoAssignConfigResult {
  managerIds: string[];
}

class AbandonmentAutoAssignService {
  private readonly db = prisma;

  async getManagerConfig(): Promise<ManagerAutoAssignConfigResult> {
    const [row, targets] = await Promise.all([
      this.db.managerAutoAssignConfig.findFirst({ select: { enabled: true } }),
      this.db.managerAutoAssignTarget.findMany({ select: { managerId: true } }),
    ]);
    return { enabled: row?.enabled ?? false, managerIds: targets.map((t) => t.managerId) };
  }

  /** `managerIds`, when passed, replaces the selected-managers set entirely (including clearing it to
   *  []). Omitted (e.g. a plain "turn off" call) leaves the existing selection untouched so it's ready
   *  to reuse the next time auto-assign is turned back on. */
  async setManagerConfig(user: AuthUser, enabled: boolean, managerIds?: string[]): Promise<ManagerAutoAssignConfigResult> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.managerAutoAssignConfig.findFirst({ select: { id: true } });
      const row = existing
        ? await tx.managerAutoAssignConfig.update({ where: { id: existing.id }, data: { enabled, updatedById: user.id } })
        : await tx.managerAutoAssignConfig.create({ data: { enabled, updatedById: user.id } });

      if (managerIds) {
        await tx.managerAutoAssignTarget.deleteMany({ where: { managerId: { notIn: managerIds } } });
        const already = await tx.managerAutoAssignTarget.findMany({ where: { managerId: { in: managerIds } }, select: { managerId: true } });
        const alreadySet = new Set(already.map((t) => t.managerId));
        const toCreate = managerIds.filter((id) => !alreadySet.has(id));
        if (toCreate.length > 0) {
          await tx.managerAutoAssignTarget.createMany({ data: toCreate.map((managerId) => ({ managerId })) });
        }
      }

      const targets = await tx.managerAutoAssignTarget.findMany({ select: { managerId: true } });
      return { enabled: row.enabled, managerIds: targets.map((t) => t.managerId) };
    });
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
