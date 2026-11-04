import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import LeadService from "../lead/lead.service.js";

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
  private readonly leadService = new LeadService();

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

  /**
   * Morning clean-up for the off-hours round-robin (LeadService.autoAssignSalespersonForLead gives overnight leads to every
   * salesperson, present or not). Moves the manager's abandoned leads that an ABSENT salesperson has not touched yet
   * (workingStatus still ASSIGNED: never called, never progressed) round-robin to the PRESENT ones. Worked leads never move.
   * With `confirm` false it only reports the plan. Nothing moves when nobody is present.
   */
  async redistributeAbsent(managerId: string, confirm: boolean): Promise<RedistributeAbsentResult> {
    const team = await this.db.user.findMany({
      where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE, reportingManagerId: managerId },
      select: { id: true, name: true, workSessions: { where: { endedAt: null }, select: { id: true }, take: 1 } },
      orderBy: { id: "asc" },
    });
    const present = team.filter((u) => u.workSessions.length > 0);
    const absent = team.filter((u) => u.workSessions.length === 0);

    const leads = absent.length === 0 ? [] : await this.db.lead.findMany({
      where: { assignedManagerId: managerId, ownerId: { in: absent.map((u) => u.id) }, workingStatus: "ASSIGNED", abandonments: { some: { status: "ACTIVE" } } },
      select: { id: true, ownerId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const absentCounts = absent.map((u) => ({ userId: u.id, name: u.name, leads: leads.filter((l) => l.ownerId === u.id).length }));
    const plan = present.map((u) => ({ userId: u.id, name: u.name, leads: 0 }));
    const byTarget = new Map<string, string[]>(present.map((u) => [u.id, []]));
    if (present.length > 0) {
      leads.forEach((lead, i) => {
        const target = present[i % present.length]!;
        byTarget.get(target.id)!.push(lead.id);
        plan[i % present.length]!.leads += 1;
      });
    }

    const movable = present.length > 0 ? leads.length : 0;
    if (confirm && movable > 0) {
      for (const [salespersonId, leadIds] of byTarget) {
        if (leadIds.length > 0) await this.leadService.bulkAssignSalespersonsByStaff(managerId, { leadIds, salespersonId });
      }
    }
    return { confirmed: confirm && movable > 0, present: present.map((u) => ({ userId: u.id, name: u.name })), absent: absentCounts, movable, plan };
  }
}

export interface RedistributeAbsentResult {
  confirmed: boolean;
  present: { userId: string; name: string }[];
  /** Each absent salesperson and how many untouched leads they hold. */
  absent: { userId: string; name: string; leads: number }[];
  movable: number;
  /** How many of the movable leads each present salesperson would receive / received. */
  plan: { userId: string; name: string; leads: number }[];
}

export default AbandonmentAutoAssignService;
