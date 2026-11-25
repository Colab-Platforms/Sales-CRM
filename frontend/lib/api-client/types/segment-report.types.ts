/** Segment lead report (/manager/analytics/segment). Lead activity only - sales and orders stay in the Sales section. */
export interface SegmentReportMetrics {
  totalLeads: number;
  contacted: number;
  pending: number;
  converted: number;
  lost: number;
  addedInPeriod: number;
  calls: number;
  connectedCalls: number;
  followUpsCompleted: number;
  followUpsPending: number;
  followUpsOverdue: number;
  activities: number;
  notes: number;
  statusChanges: number;
  assignments: number;
  activityByType: { type: string; count: number }[];
}

export interface SegmentLeadRow {
  id: string;
  leadNumber: string;
  name: string;
  phone: string | null;
  email: string | null;
  location: string | null;
  salesperson: string | null;
  manager: string | null;
  source: string | null;
  status: string;
  priority: string;
  stage: string;
  createdAt: string;
  lastContactedAt: string | null;
  lastActivityAt: string | null;
  calls: number;
  connectedCalls: number;
  activities: number;
  notes: number;
  followUpsCompleted: number;
  followUpsPending: number;
}

/** Members of the segment that the Leads section does not list. Reported on their own; never part of a total or metric. */
export interface SegmentExcluded {
  total: number;
  /** Converted to customer (includes customersFromAbandonedCart). */
  customers: number;
  customersFromAbandonedCart: number;
  /** From an abandoned cart and not a customer. customers + abandonedCart = total. */
  abandonedCart: number;
  byStatus: { status: string; count: number }[];
  calls: number;
  activities: number;
}

export interface SegmentReport {
  view: "listed" | "excluded";
  excluded: SegmentExcluded;
  segment: { id: string; name: string; color: string; isSystem: boolean; isActive: boolean };
  range: { from: string; to: string };
  metrics: SegmentReportMetrics;
  leads: SegmentLeadRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/** The metric cards; each name is the metric's field in SegmentReportMetrics. */
export type SegmentDrillMetric = "totalLeads" | "contacted" | "pending" | "converted" | "lost" | "calls" | "followUpsCompleted" | "followUpsPending" | "activities";

interface DrillLeadRef {
  id: string;
  leadId: string;
  leadNumber: string;
  leadName: string;
  phone: string | null;
}
export type SegmentDrillRecords =
  | { kind: "leads"; rows: SegmentLeadRow[] }
  | { kind: "calls"; rows: (DrillLeadRef & { agent: string | null; at: string; direction: string; status: string; outcome: string | null; durationSeconds: number | null; notes: string | null })[] }
  | { kind: "followUps"; rows: (DrillLeadRef & { assignedTo: string | null; type: string; status: string; title: string; notes: string | null; scheduledAt: string | null; completedAt: string | null; overdue: boolean })[] }
  | { kind: "activities"; rows: (DrillLeadRef & { type: string; title: string | null; description: string | null; by: string | null; at: string })[] };

/** One page of the records behind a card (/manager/analytics/segment/details). */
export type SegmentDetails = SegmentDrillRecords & { metric: SegmentDrillMetric; pagination: SegmentReport["pagination"] };

export interface SegmentLeadHistory {
  lead: { id: string; leadNumber: string; name: string; phone: string | null; status: string; salesperson: string | null };
  activities: { id: string; type: string; title: string | null; description: string | null; createdAt: string; by: string | null }[];
  calls: { id: string; status: string; direction: string; durationSeconds: number | null; notes: string | null; startedAt: string | null; createdAt: string; by: string | null; outcome: string | null }[];
  tasks: { id: string; type: string; status: string; title: string; description: string | null; scheduledAt: string | null; completedAt: string | null; createdAt: string; assignedTo: string | null }[];
  limit: number;
}
