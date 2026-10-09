// Kept in sync with backend/src/modules/tickets.
import type { Role } from "./auth.types";

export type TicketCategory = "LEAD_ISSUE" | "ORDER_PAYMENT" | "WHATSAPP_CALLING" | "LOGIN_ACCESS" | "TECHNICAL_BUG" | "OTHER";
export type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export interface TicketActor {
  id: string;
  name: string;
  role: Role;
}

export interface TicketView {
  id: string;
  ticketNumber: number;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  subject: string;
  description: string;
  raisedBy: TicketActor;
  resolvedBy: TicketActor | null;
  resolvedAt: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  body: string;
  author: TicketActor;
  createdAt: string;
}

export interface TicketDetail extends TicketView {
  comments: TicketComment[];
}

export interface CreateTicketInput {
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  description: string;
}

export interface TicketListParams {
  status?: TicketStatus;
  page?: number;
  pageSize?: number;
}

export interface TicketListResult {
  items: TicketView[];
  total: number;
  page: number;
  pageSize: number;
}
