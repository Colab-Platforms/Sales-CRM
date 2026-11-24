export interface SegmentCounts {
  total: number;
  assigned: number;
  unassigned: number;
  withManagerOnly: number;
  withSalesperson: number;
}

export interface Segment {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  isSystem: boolean;
  createdAt: string;
  /** null when the caller may not see counts (salespeople) or they were not requested. */
  counts?: SegmentCounts | null;
}

export interface CreateSegmentPayload {
  name: string;
  color?: string;
}

export interface UpdateSegmentPayload {
  name?: string;
  color?: string;
  isActive?: boolean;
}
