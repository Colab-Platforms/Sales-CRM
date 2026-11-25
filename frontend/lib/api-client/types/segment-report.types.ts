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

export interface SegmentReport {
  segment: { id: string; name: string; color: string; isSystem: boolean; isActive: boolean };
  range: { from: string; to: string };
  metrics: SegmentReportMetrics;
  leads: SegmentLeadRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface SegmentLeadHistory {
  lead: { id: string; leadNumber: string; name: string; phone: string | null; status: string; salesperson: string | null };
  activities: { id: string; type: string; title: string | null; description: string | null; createdAt: string; by: string | null }[];
  calls: { id: string; status: string; direction: string; durationSeconds: number | null; notes: string | null; startedAt: string | null; createdAt: string; by: string | null; outcome: string | null }[];
  tasks: { id: string; type: string; status: string; title: string; description: string | null; scheduledAt: string | null; completedAt: string | null; createdAt: string; assignedTo: string | null }[];
  limit: number;
}
