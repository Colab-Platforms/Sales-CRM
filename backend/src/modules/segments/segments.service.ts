import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role } from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";

// CAMPAIGN SEGMENTS: admin-defined groups of leads for a campaign. Membership lives in LeadSegment (a relation, not a text column), so a lead can be in several segments and assigning it never changes them.
// Customer classification (Repeat / Loyal / VIP, from order history) is a different thing and is never touched here.

export const segmentKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();
export const cleanName = (name: string): string => name.trim().replace(/\s+/g, " ");

const SELECT = { id: true, name: true, color: true, isActive: true, isSystem: true, createdAt: true } as const;

export type SegmentCounts = { total: number; assigned: number; unassigned: number; withManagerOnly: number; withSalesperson: number };
const EMPTY: SegmentCounts = { total: 0, assigned: 0, unassigned: 0, withManagerOnly: 0, withSalesperson: 0 };

function uniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

class SegmentService {
  /**
   * Segments for the filters, the import screen and the Segment Management page. Counts (total / assigned / unassigned) are what the caller may see: everything for an Admin, only the leads under them for a manager.
   * A salesperson only needs the tag list, so gets no counts.
   */
  async list(user: AuthUser, opts: { includeInactive?: boolean; withCounts?: boolean } = {}) {
    const segments = await prisma.segment.findMany({
      where: user.role === Role.ADMIN && opts.includeInactive ? {} : { isActive: true },
      select: SELECT,
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    });
    if (!opts.withCounts || user.role === Role.SALESPERSON) return segments.map((s) => ({ ...s, counts: null as SegmentCounts | null }));
    const counts = await this.countsBySegment(user);
    return segments.map((s) => ({ ...s, counts: counts.get(s.id) ?? EMPTY }));
  }

  /** One grouped query for every segment: total leads, and how many already have a manager or a salesperson. */
  async countsBySegment(user: AuthUser): Promise<Map<string, SegmentCounts>> {
    const scope = user.role === Role.MANAGER ? Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid` : user.role === Role.SALESPERSON ? Prisma.sql`AND l.owner_id = ${user.id}::uuid` : Prisma.empty;
    const rows = await prisma.$queryRaw<{ segment_id: string; total: bigint; with_manager_only: bigint; with_salesperson: bigint }[]>`
      SELECT ls.segment_id,
             count(*)::bigint AS total,
             count(*) FILTER (WHERE l.assigned_manager_id IS NOT NULL AND l.owner_id IS NULL)::bigint AS with_manager_only,
             count(*) FILTER (WHERE l.owner_id IS NOT NULL)::bigint AS with_salesperson
      FROM lead_segments ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE l.lifecycle_stage = 'LEAD' ${scope}
      GROUP BY ls.segment_id`;
    const out = new Map<string, SegmentCounts>();
    for (const r of rows) {
      const total = Number(r.total);
      const withManagerOnly = Number(r.with_manager_only);
      const withSalesperson = Number(r.with_salesperson);
      out.set(r.segment_id, { total, assigned: withManagerOnly + withSalesperson, unassigned: total - withManagerOnly - withSalesperson, withManagerOnly, withSalesperson });
    }
    return out;
  }

  async create(user: AuthUser, data: { name: string; color?: string }) {
    const name = cleanName(data.name);
    try {
      return await prisma.segment.create({ data: { name, nameKey: segmentKey(name), color: data.color ?? "#6366f1", createdById: user.id }, select: SELECT });
    } catch (error) {
      if (uniqueViolation(error)) throw new ApiError("A segment with this name already exists", STATUS_CODES.CONFLICT);
      throw error;
    }
  }

  private async getOrThrow(id: string) {
    const segment = await prisma.segment.findUnique({ where: { id }, select: SELECT });
    if (!segment) throw new ApiError("Segment not found", STATUS_CODES.NOT_FOUND);
    return segment;
  }

  async update(id: string, data: { name?: string; color?: string; isActive?: boolean }) {
    await this.getOrThrow(id);
    const patch: Prisma.SegmentUpdateInput = {};
    if (data.name !== undefined) {
      patch.name = cleanName(data.name);
      patch.nameKey = segmentKey(data.name);
    }
    if (data.color !== undefined) patch.color = data.color;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    try {
      return await prisma.segment.update({ where: { id }, data: patch, select: SELECT });
    } catch (error) {
      if (uniqueViolation(error)) throw new ApiError("A segment with this name already exists", STATUS_CODES.CONFLICT);
      throw error;
    }
  }

  /** Only a segment nothing belongs to can be deleted. One that has leads must be archived (deactivated) instead: its tags stay on the leads, it just can't be chosen for new imports. */
  async remove(id: string) {
    const segment = await this.getOrThrow(id);
    if (segment.isSystem) throw new ApiError("The built-in segments cannot be deleted. Deactivate it instead.", STATUS_CODES.CONFLICT);
    const members = await prisma.leadSegment.count({ where: { segmentId: id } });
    if (members > 0) throw new ApiError(`This segment has ${members} lead${members === 1 ? "" : "s"}. Deactivate (archive) it instead of deleting it.`, STATUS_CODES.CONFLICT);
    await prisma.segment.delete({ where: { id } });
    return { id };
  }

  async stats(user: AuthUser, id: string) {
    const segment = await this.getOrThrow(id);
    const counts = (await this.countsBySegment(user)).get(id) ?? EMPTY;
    return { ...segment, counts };
  }

  /** An import may only use an existing, active segment. */
  async requireUsable(id: string) {
    const segment = await this.getOrThrow(id);
    if (!segment.isActive) throw new ApiError("This segment is inactive. Choose an active segment.", STATUS_CODES.BAD_REQUEST);
    return segment;
  }
}

export const segmentService = new SegmentService();
export default SegmentService;
