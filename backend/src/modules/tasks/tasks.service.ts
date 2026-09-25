import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { TaskStatus } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { FOLLOW_UP_TASK_TYPES, lockFollowUpsFor, nextFreeSlot } from "./tasks.followup.js";

// How far ahead the reminder list looks. The browser only needs today's and tomorrow's reminders to
// fire notifications on time; anything later shows up once it comes into range.
const LOOKAHEAD_MS = 36 * 60 * 60 * 1000;

const followUpSelect = {
  id: true,
  type: true,
  title: true,
  description: true,
  scheduledAt: true,
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true } },
} as const;

class TasksService {
  // Only the person the reminder belongs to gets it - a manager doesn't get pinged for their team.
  async listMyFollowUps(user: AuthUser) {
    return prisma.task.findMany({
      where: {
        assignedToId: user.id,
        status: TaskStatus.PENDING,
        type: { in: [...FOLLOW_UP_TASK_TYPES] },
        scheduledAt: { not: null, lte: new Date(Date.now() + LOOKAHEAD_MS) },
      },
      select: followUpSelect,
      orderBy: { scheduledAt: "asc" },
    });
  }

  private async getOwnPendingTaskOrThrow(user: AuthUser, id: string) {
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.assignedToId !== user.id) throw new ApiError("Reminder not found", STATUS_CODES.NOT_FOUND);
    if (task.status !== TaskStatus.PENDING) throw new ApiError("This reminder is already closed", STATUS_CODES.CONFLICT);
    return task;
  }

  async completeTask(user: AuthUser, id: string) {
    await this.getOwnPendingTaskOrThrow(user, id);
    return prisma.task.update({
      where: { id },
      data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
      select: followUpSelect,
    });
  }

  async snoozeTask(user: AuthUser, id: string, minutes: number) {
    const task = await this.getOwnPendingTaskOrThrow(user, id);
    return prisma.$transaction(async (tx) => {
      await lockFollowUpsFor(tx, task.assignedToId);
      // If another lead already holds that minute, push this one to the next free minute instead of failing.
      const scheduledAt = await nextFreeSlot(tx, task.assignedToId, task.leadId, new Date(Date.now() + minutes * 60_000));
      return tx.task.update({ where: { id }, data: { scheduledAt }, select: followUpSelect });
    });
  }
}

export default TasksService;
