// Pure builders that turn rows from the various CRM tables into TimelineEntry objects for
// Customer 360. Kept separate from customers.service.ts so the merge/ordering logic can be unit
// tested without a database. No event is invented here: every entry traces back to a real column
// on a real row the service fetched.
import type {
  AssignmentType,
  CallDirection,
  CallStatus,
  InterestedPeriodStatus,
  RecoveryActionStatus,
  RecoveryActionType,
  TaskStatus,
} from "../../../generated/prisma/enums.js";
import { ActivityType, AbandonmentType } from "../../../generated/prisma/enums.js";
import { ORDER_REFERENCE_TYPE } from "../orders/orders.types.js";
import type { TimelineEntry } from "./customers.types.js";

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface ActivityRow {
  id: string;
  type: ActivityType;
  referenceType: string | null;
  referenceId: string | null;
  // Direct order pointer (E6.6 Audit Trail); null on rows written before this column existed, in
  // which case referenceType/referenceId (checked below) still identify the order.
  orderId: string | null;
  title: string | null;
  description: string | null;
  createdAt: Date;
  actor: { id: string; name: string } | null;
}

export function buildLeadCreatedEntry(lead: { id: string; createdAt: Date }): TimelineEntry {
  return {
    id: `lead:${lead.id}:created`,
    type: "LEAD_CREATED",
    title: "Lead created",
    description: null,
    occurredAt: lead.createdAt,
    actor: null,
    order: null,
    source: "RECORD",
  };
}

export interface AssignmentRow {
  id: string;
  assignmentType: AssignmentType;
  assignedAt: Date;
  user: { id: string; name: string };
  assignedBy: { id: string; name: string } | null;
}

export function buildAssignmentEntries(assignments: AssignmentRow[]): TimelineEntry[] {
  return assignments.map((a) => ({
    id: `assignment:${a.id}`,
    type: a.assignmentType === "REASSIGNMENT" ? "REASSIGNMENT" : "ASSIGNMENT",
    title:
      a.assignmentType === "REASSIGNMENT"
        ? `Lead reassigned to ${a.user.name}`
        : `Lead assigned to ${a.user.name}`,
    description: `${humanize(a.assignmentType)} assignment`,
    occurredAt: a.assignedAt,
    actor: a.assignedBy,
    order: null,
    source: "RECORD",
  }));
}

export interface CallRow {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  startedAt: Date | null;
  createdAt: Date;
  durationSeconds: number | null;
  agent: { id: string; name: string } | null;
  outcome: { name: string } | null;
}

export function buildCallEntries(calls: CallRow[]): TimelineEntry[] {
  return calls.map((call) => {
    const durationText = call.durationSeconds ? ` (${Math.round(call.durationSeconds / 60)} min)` : "";
    return {
      id: `call:${call.id}`,
      type: "CALL",
      title: `${call.direction === "INBOUND" ? "Inbound" : "Outbound"} call — ${humanize(call.status)}${durationText}`,
      description: call.outcome?.name ?? null,
      occurredAt: call.startedAt ?? call.createdAt,
      actor: call.agent,
      order: null,
      source: "RECORD",
    };
  });
}

export interface InterestedPeriodRow {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  status: InterestedPeriodStatus;
  qualifiedBy: { id: string; name: string } | null;
}

export function buildInterestedEntries(periods: InterestedPeriodRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const period of periods) {
    entries.push({
      id: `interested:${period.id}:started`,
      type: "INTERESTED_STARTED",
      title: "Marked as interested",
      description: null,
      occurredAt: period.startedAt,
      actor: period.qualifiedBy,
      order: null,
      source: "RECORD",
    });
    if (period.endedAt) {
      entries.push({
        id: `interested:${period.id}:ended`,
        type: "INTERESTED_ENDED",
        title: `Interested period ${humanize(period.status).toLowerCase()}`,
        description: null,
        occurredAt: period.endedAt,
        actor: null,
        order: null,
        source: "RECORD",
      });
    }
  }
  return entries;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  scheduledAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  assignedTo: { id: string; name: string } | null;
}

export function buildTaskEntries(tasks: TaskRow[]): TimelineEntry[] {
  return tasks.map((task) => ({
    id: `task:${task.id}`,
    type: "TASK",
    title: task.title,
    description: task.description ?? `Status: ${humanize(task.status)}`,
    occurredAt: task.completedAt ?? task.scheduledAt ?? task.createdAt,
    actor: task.assignedTo,
    order: null,
    source: "RECORD",
  }));
}

const ABANDONMENT_LABELS: Record<AbandonmentType, string> = {
  [AbandonmentType.CHECKOUT]: "Checkout abandoned",
  [AbandonmentType.PAYMENT]: "Payment abandoned",
  [AbandonmentType.SALES]: "Sales opportunity abandoned",
};

export interface AbandonmentRow {
  id: string;
  type: AbandonmentType;
  detectedAt: Date;
  status: string;
  recoveredAt: Date | null;
}

export function buildAbandonmentEntries(abandonments: AbandonmentRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const a of abandonments) {
    entries.push({
      id: `abandonment:${a.id}:detected`,
      type: "ABANDONMENT",
      title: ABANDONMENT_LABELS[a.type],
      description: null,
      occurredAt: a.detectedAt,
      actor: null,
      order: null,
      source: "RECORD",
    });
    if (a.recoveredAt) {
      entries.push({
        id: `abandonment:${a.id}:recovered`,
        type: "ABANDONMENT_RECOVERED",
        title: "Abandonment recovered",
        description: null,
        occurredAt: a.recoveredAt,
        actor: null,
        order: null,
        source: "RECORD",
      });
    }
  }
  return entries;
}

export interface RecoveryActionRow {
  id: string;
  type: RecoveryActionType;
  status: RecoveryActionStatus;
  createdAt: Date;
  completedAt: Date | null;
  performedBy: { id: string; name: string } | null;
}

export function buildRecoveryEntries(actions: RecoveryActionRow[]): TimelineEntry[] {
  return actions.map((action) => ({
    id: `recovery:${action.id}`,
    type: "RECOVERY_ACTION",
    title: `Recovery ${humanize(action.type).toLowerCase()} — ${humanize(action.status).toLowerCase()}`,
    description: null,
    occurredAt: action.completedAt ?? action.createdAt,
    actor: action.performedBy,
    order: null,
    source: "RECORD",
  }));
}

// ---- Orders: mirrors orders.service.ts' getStatusHistory, but batched across every order the
// lead has, and without a second DB round trip per order. ----

export interface ShipmentMilestoneRow {
  id: string;
  courier: string | null;
  trackingNumber: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  status: string;
  createdAt: Date;
  placedAt: Date | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  shipments: ShipmentMilestoneRow[];
}

// Shopify does not report when a fulfilment entered transit or when a return completed, so only
// the two timestamps it does give (shipped, delivered) become timeline milestones - never guessed.
function shipmentEntries(orderLink: TimelineEntry["order"], shipments: ShipmentMilestoneRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const shipment of shipments) {
    const via = shipment.courier ? ` via ${shipment.courier}` : "";
    const awb = shipment.trackingNumber ? ` (AWB ${shipment.trackingNumber})` : "";
    if (shipment.shippedAt) {
      entries.push({
        id: `shipment:${shipment.id}:SHIPPED`,
        type: "SHIPMENT_SHIPPED",
        title: `Shipped${via}`,
        description: shipment.trackingNumber ? `Tracking${awb}` : null,
        occurredAt: shipment.shippedAt,
        actor: null,
        order: orderLink,
        source: "RECORD",
      });
    }
    if (shipment.deliveredAt) {
      entries.push({
        id: `shipment:${shipment.id}:DELIVERED`,
        type: "SHIPMENT_DELIVERED",
        title: `Delivered${via}`,
        description: null,
        occurredAt: shipment.deliveredAt,
        actor: null,
        order: orderLink,
        source: "RECORD",
      });
    }
    if (shipment.returnedAt) {
      entries.push({
        id: `shipment:${shipment.id}:RETURNED`,
        type: "SHIPMENT_RETURNED",
        title: `Returned${via}`,
        description: null,
        occurredAt: shipment.returnedAt,
        actor: null,
        order: orderLink,
        source: "RECORD",
      });
    }
  }
  return entries;
}

// Historical rows (written before the E6.6 Audit Trail added orderId/specific types) used the generic
// STATUS_CHANGE/PAYMENT types with referenceType="Order"; new rows use more specific types (and, for
// payments/shipments, a more specific referenceType) but always set orderId. Both keep rendering as
// the same timeline entry type here, so nothing already shown in Customer 360 changes or duplicates.
// Shipment/discount/mismatch/cancellation events are deliberately NOT mapped: shipments already have
// their own RECORD-sourced milestones below, and order cancellation already has its own RECORD
// milestone too - mapping their Activity rows here as well would show every one of those facts twice.
const ORDER_ACTIVITY_EVENT: Partial<Record<ActivityType, { type: TimelineEntry["type"]; fallbackTitle: string }>> = {
  [ActivityType.ORDER_CREATED]: { type: "ORDER_CREATED", fallbackTitle: "Order created" },
  [ActivityType.ORDER_CONFIRMED]: { type: "ORDER_CONFIRMED", fallbackTitle: "Order confirmed" },
  [ActivityType.STATUS_CHANGE]: { type: "ORDER_STATUS_CHANGE", fallbackTitle: "Order status changed" },
  [ActivityType.ORDER_STATUS_CHANGED]: { type: "ORDER_STATUS_CHANGE", fallbackTitle: "Order status changed" },
  [ActivityType.PAYMENT]: { type: "PAYMENT", fallbackTitle: "Payment update" },
  [ActivityType.PAYMENT_CREATED]: { type: "PAYMENT", fallbackTitle: "Payment recorded" },
  [ActivityType.PAYMENT_STATUS_CHANGED]: { type: "PAYMENT", fallbackTitle: "Payment status changed" },
  [ActivityType.PAYMENT_REFUNDED]: { type: "PAYMENT", fallbackTitle: "Payment refunded" },
};

export function buildOrderEntries(orders: OrderRow[], activities: ActivityRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const order of orders) {
    const orderLink = { id: order.id, orderNumber: order.orderNumber, externalNumber: order.externalNumber };
    const orderActivities = activities.filter(
      (a) => a.orderId === order.id || (a.referenceType === ORDER_REFERENCE_TYPE && a.referenceId === order.id),
    );

    for (const activity of orderActivities) {
      const meta = ORDER_ACTIVITY_EVENT[activity.type];
      if (!meta) continue;
      entries.push({
        id: activity.id,
        type: meta.type,
        title: activity.title ?? meta.fallbackTitle,
        description: activity.description,
        occurredAt: activity.createdAt,
        actor: activity.actor,
        order: orderLink,
        source: "ACTIVITY",
      });
    }

    const recorded = new Set(orderActivities.map((a) => a.type));
    const milestone = (id: string, type: TimelineEntry["type"], title: string, occurredAt: Date | null) => {
      if (!occurredAt) return;
      entries.push({ id, type, title, description: null, occurredAt, actor: null, order: orderLink, source: "RECORD" });
    };

    if (!recorded.has(ActivityType.ORDER_CREATED)) {
      milestone(`order:${order.id}:CREATED`, "ORDER_CREATED", `Order ${order.orderNumber} created`, order.createdAt);
    }
    milestone(`order:${order.id}:PLACED`, "ORDER_PLACED", `Order ${order.orderNumber} placed`, order.placedAt);
    if (!recorded.has(ActivityType.ORDER_CONFIRMED)) {
      milestone(`order:${order.id}:CONFIRMED`, "ORDER_CONFIRMED", `Order ${order.orderNumber} confirmed`, order.confirmedAt);
    }
    milestone(`order:${order.id}:CANCELLED`, "ORDER_CANCELLED", `Order ${order.orderNumber} cancelled`, order.cancelledAt);

    entries.push(...shipmentEntries(orderLink, order.shipments));
  }

  return entries;
}

// Most recent first: a customer relationship can span years of orders and calls, so a paginated
// feed is far more useful read newest-to-oldest than the single order's status history (which
// stays small and reads oldest-to-newest like a receipt).
export function sortTimelineDesc(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const diff = b.occurredAt.getTime() - a.occurredAt.getTime();
    return diff !== 0 ? diff : b.id.localeCompare(a.id);
  });
}
