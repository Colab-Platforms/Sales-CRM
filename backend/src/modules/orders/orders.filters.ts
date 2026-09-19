import { PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { NO_PAYMENT, type ListOrdersQuery, type PaymentStatusFilter } from "./orders.types.js";

// An order can carry several payment attempts. Its single "payment status" is the most
// conclusive outcome among them, so a failed attempt followed by a successful retry reads
// SUCCESS, and a refunded payment reads REFUNDED. Listing, filtering and the detail view
// all use this one rule so they can never disagree.
export const PAYMENT_STATUS_PRECEDENCE: PaymentStatus[] = [
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.SUCCESS,
  PaymentStatus.PROCESSING,
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
];

export function derivePaymentStatus(payments: { status: PaymentStatus }[]): PaymentStatus | null {
  return PAYMENT_STATUS_PRECEDENCE.find((status) => payments.some((p) => p.status === status)) ?? null;
}

// Database-side equivalent of derivePaymentStatus().
export function paymentStatusWhere(status: PaymentStatusFilter): Prisma.OrderWhereInput {
  if (status === NO_PAYMENT) {
    return { payments: { none: {} } };
  }

  const outranking = PAYMENT_STATUS_PRECEDENCE.slice(0, PAYMENT_STATUS_PRECEDENCE.indexOf(status));
  const conditions: Prisma.OrderWhereInput[] = [{ payments: { some: { status } } }];
  if (outranking.length > 0) {
    conditions.push({ payments: { none: { status: { in: outranking } } } });
  }
  return { AND: conditions };
}

// Every word must match at least one field, so "priya 98765" or "ORD-1001 priya" both work.
const MAX_SEARCH_TERMS = 5;

export function searchWhere(search: string): Prisma.OrderWhereInput {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);

  return {
    AND: terms.map((term): Prisma.OrderWhereInput => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        OR: [
          { orderNumber: contains },
          { lead: { leadNumber: contains } },
          { lead: { firstName: contains } },
          { lead: { lastName: contains } },
          { lead: { mobile: contains } },
          { lead: { email: contains } },
          { payments: { some: { transactionReference: contains } } },
        ],
      };
    }),
  };
}

// "Salesperson" on an order is whoever booked it; website/API orders have nobody, so they
// fall back to the current owner of the original lead.
export function salespersonWhere(userId: string): Prisma.OrderWhereInput {
  return { OR: [{ createdById: userId }, { createdById: null, lead: { ownerId: userId } }] };
}

export function buildOrderWhere(query: ListOrdersQuery, leadScope: Prisma.LeadWhereInput): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.search) and.push(searchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.source) and.push({ source: query.source });
  if (query.paymentStatus) and.push(paymentStatusWhere(query.paymentStatus));
  if (query.salespersonId) and.push(salespersonWhere(query.salespersonId));
  if (query.dateFrom || query.dateTo) {
    and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  }

  return and.length > 0 ? { AND: and } : {};
}

// One order, but only if the user's lead scope allows it.
export function scopedOrderWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.OrderWhereInput {
  return Object.keys(leadScope).length > 0 ? { AND: [{ id }, { lead: leadScope }] } : { id };
}

export function fullName(firstName: string, lastName: string | null): string {
  return lastName ? `${firstName} ${lastName}` : firstName;
}
