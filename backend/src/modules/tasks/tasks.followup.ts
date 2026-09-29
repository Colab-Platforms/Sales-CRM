import {
  ActivityType,
  TaskStatus,
  TaskType,
  type Role,
} from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

type Db = Prisma.TransactionClient;

// The two follow-up kinds that carry a reminder time. A lead has at most one of these pending at a
// time: scheduling a new one replaces (cancels) the old, and logging the next call completes it.
export const FOLLOW_UP_TASK_TYPES = [
  TaskType.CALLBACK,
  TaskType.FOLLOW_UP,
] as const;

// A small grace window so a time picked "now" in the browser isn't rejected over clock skew.
const PAST_GRACE_MS = 60_000;

export function parseFollowUpAt(
  value: string | undefined,
  label: string,
): Date {
  if (!value)
    throw new ApiError(
      `Pick a date and time for the ${label}`,
      STATUS_CODES.BAD_REQUEST,
    );
  const at = new Date(value);
  if (Number.isNaN(at.getTime()))
    throw new ApiError("Invalid follow-up time", STATUS_CODES.BAD_REQUEST);
  if (at.getTime() < Date.now() - PAST_GRACE_MS) {
    throw new ApiError(
      "The follow-up time is in the past",
      STATUS_CODES.BAD_REQUEST,
    );
  }
  return at;
}

// One person can only be on one call at a time, and a call takes a few minutes, so two reminders for the
// same salesperson must be at least MIN_GAP_MS apart. This is a sliding window either side of the time
// (not fixed buckets): 4:29 and 4:31 clash, 4:30 and 4:35 don't. Keep in sync with MIN_GAP_MS in the
// frontend's follow-up-utils.ts.
export const MIN_GAP_MS = 5 * 60_000;

/** Serialises follow-up scheduling per person, so two requests can't both grab the same free time. */
export async function lockFollowUpsFor(
  tx: Db,
  assignedToId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`follow-up:${assignedToId}`}))`;
}

// Another lead's pending reminder for this person closer than MIN_GAP_MS to `at`. The lead's own
// pending reminder is ignored: it is about to be replaced, so re-scheduling a lead to a nearby time is
// never a conflict.
async function findConflict(
  tx: Db,
  assignedToId: string,
  leadId: string,
  at: Date,
) {
  return tx.task.findFirst({
    where: {
      assignedToId,
      leadId: { not: leadId },
      status: TaskStatus.PENDING,
      type: { in: [...FOLLOW_UP_TASK_TYPES] },
      scheduledAt: {
        gt: new Date(at.getTime() - MIN_GAP_MS),
        lt: new Date(at.getTime() + MIN_GAP_MS),
      },
    },
    orderBy: { scheduledAt: "desc" },
    select: {
      scheduledAt: true,
      lead: { select: { firstName: true, lastName: true } },
    },
  });
}

/** Rejects a time too close to another lead's reminder. Call inside the person's lock. */
export async function assertSlotFree(
  tx: Db,
  assignedToId: string,
  leadId: string,
  at: Date,
): Promise<void> {
  const clash = await findConflict(tx, assignedToId, leadId, at);
  if (!clash) return;
  const name = [clash.lead.firstName, clash.lead.lastName]
    .filter(Boolean)
    .join(" ");
  throw new ApiError(
    `${name} already has a reminder within ${MIN_GAP_MS / 60_000} minutes of that time - keep at least ${MIN_GAP_MS / 60_000} minutes between call backs and follow ups. Pick a different time.`,
    STATUS_CODES.CONFLICT,
  );
}

/** The first time at or after `from` that is free for this person (used to nudge a snooze forward). */
export async function nextFreeSlot(
  tx: Db,
  assignedToId: string,
  leadId: string,
  from: Date,
): Promise<Date> {
  let at = from;
  for (let i = 0; i < 100; i++) {
    const clash = await findConflict(tx, assignedToId, leadId, at);
    if (!clash) return at;
    // Jump straight past the blocking reminder instead of stepping minute by minute.
    at = new Date(clash.scheduledAt!.getTime() + MIN_GAP_MS);
  }
  return at;
}

/** Marks every pending follow-up on this lead done - the lead was just called (or re-scheduled). */
export async function completePendingFollowUps(
  tx: Db,
  leadId: string,
): Promise<void> {
  await tx.task.updateMany({
    where: {
      leadId,
      status: TaskStatus.PENDING,
      type: { in: [...FOLLOW_UP_TASK_TYPES] },
    },
    data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
  });
}

export interface ScheduleFollowUpInput {
  leadId: string;
  leadName: string;
  assignedToId: string;
  actor: { id: string; role: Role };
  type: (typeof FOLLOW_UP_TASK_TYPES)[number];
  scheduledAt: Date;
  note?: string | null;
}

/** Replaces any pending follow-up on the lead with a new reminder at `scheduledAt`. */
export async function scheduleFollowUp(tx: Db, input: ScheduleFollowUpInput) {
  await lockFollowUpsFor(tx, input.assignedToId);
  await assertSlotFree(tx, input.assignedToId, input.leadId, input.scheduledAt);

  await tx.task.updateMany({
    where: {
      leadId: input.leadId,
      status: TaskStatus.PENDING,
      type: { in: [...FOLLOW_UP_TASK_TYPES] },
    },
    data: { status: TaskStatus.CANCELLED },
  });

  const kind = input.type === TaskType.CALLBACK ? "Call back" : "Follow up";
  const task = await tx.task.create({
    data: {
      leadId: input.leadId,
      assignedToId: input.assignedToId,
      createdById: input.actor.id,
      type: input.type,
      title: `${kind} ${input.leadName}`.slice(0, 200),
      description: input.note?.trim() || null,
      scheduledAt: input.scheduledAt,
    },
  });

  await tx.activity.create({
    data: {
      leadId: input.leadId,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      type: ActivityType.TASK,
      referenceType: "TASK",
      referenceId: task.id,
      title: `${kind} scheduled`,
      description: input.scheduledAt.toISOString(),
    },
  });

  return task;
}
