import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role, TicketStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { CreateTicketBody, ListTicketsQuery } from "./tickets.validators.js";

const actorSelect = { id: true, name: true, role: true } as const;

const ticketInclude = {
  raisedBy: { select: actorSelect },
  resolvedBy: { select: actorSelect },
  _count: { select: { comments: true } },
} satisfies Prisma.TicketInclude;

type TicketRow = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;

function serialize(t: TicketRow) {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    category: t.category,
    priority: t.priority,
    status: t.status,
    subject: t.subject,
    description: t.description,
    raisedBy: t.raisedBy,
    resolvedBy: t.resolvedBy,
    resolvedAt: t.resolvedAt,
    commentCount: t._count.comments,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// Whose tickets this user may see: a salesperson their own, a manager their direct reports', an admin everyone's.
function scopeWhere(user: AuthUser): Prisma.TicketWhereInput {
  if (user.role === Role.ADMIN) return {};
  if (user.role === Role.MANAGER) return { raisedBy: { reportingManagerId: user.id } };
  if (user.role === Role.SALESPERSON) return { raisedById: user.id };
  return { id: { in: [] } };
}

export class TicketsService {
  private async findScoped(user: AuthUser, id: string) {
    const ticket = await prisma.ticket.findFirst({ where: { AND: [{ id }, scopeWhere(user)] }, include: ticketInclude });
    if (!ticket) throw new ApiError("Ticket not found", STATUS_CODES.NOT_FOUND);
    return ticket;
  }

  async create(user: AuthUser, body: CreateTicketBody) {
    const ticket = await prisma.ticket.create({ data: { ...body, raisedById: user.id }, include: ticketInclude });
    return serialize(ticket);
  }

  async list(user: AuthUser, query: ListTicketsQuery) {
    const where: Prisma.TicketWhereInput = { AND: [scopeWhere(user), query.status ? { status: query.status } : {}] };
    const [total, rows] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        include: ticketInclude,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map(serialize), total, page: query.page, pageSize: query.pageSize };
  }

  // Tickets still needing attention: open or in progress.
  async openCount(user: AuthUser) {
    const count = await prisma.ticket.count({
      where: { AND: [scopeWhere(user), { status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] } }] },
    });
    return { count };
  }

  async get(user: AuthUser, id: string) {
    const ticket = await this.findScoped(user, id);
    const comments = await prisma.ticketComment.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: "asc" },
      include: { author: { select: actorSelect } },
    });
    return {
      ...serialize(ticket),
      comments: comments.map((c) => ({ id: c.id, body: c.body, author: c.author, createdAt: c.createdAt })),
    };
  }

  async addComment(user: AuthUser, id: string, body: string) {
    const ticket = await this.findScoped(user, id);
    if (ticket.status === TicketStatus.CLOSED) throw new ApiError("This ticket is closed. Reopen it to add a comment.", STATUS_CODES.CONFLICT);
    const [comment] = await prisma.$transaction([
      prisma.ticketComment.create({ data: { ticketId: id, authorId: user.id, body }, include: { author: { select: actorSelect } } }),
      // Touch the ticket so it shows as recently active.
      prisma.ticket.update({ where: { id }, data: { updatedAt: new Date() } }),
    ]);
    return { id: comment.id, body: comment.body, author: comment.author, createdAt: comment.createdAt };
  }

  async setStatus(user: AuthUser, id: string, status: TicketStatus) {
    const ticket = await this.findScoped(user, id);
    if (user.role === Role.SALESPERSON) {
      // The raiser can only close their own ticket (problem gone) or reopen it (not actually fixed).
      const reopen = status === TicketStatus.OPEN && (ticket.status === TicketStatus.RESOLVED || ticket.status === TicketStatus.CLOSED);
      if (status !== TicketStatus.CLOSED && !reopen) throw new ApiError("You can only close or reopen your own ticket", STATUS_CODES.FORBIDDEN);
    }
    if (ticket.status === status) return serialize(ticket);
    const resolving = status === TicketStatus.RESOLVED || status === TicketStatus.CLOSED;
    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        status,
        resolvedById: resolving ? (ticket.resolvedById ?? user.id) : null,
        resolvedAt: resolving ? (ticket.resolvedAt ?? new Date()) : null,
      },
      include: ticketInclude,
    });
    return serialize(updated);
  }
}

export const ticketsService = new TicketsService();
