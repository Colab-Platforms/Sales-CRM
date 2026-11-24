import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CreateSegmentPayload, Segment, UpdateSegmentPayload } from "../types/segment.types";

export const segmentApi = {
  async list(opts: { includeInactive?: boolean; counts?: boolean } = {}): Promise<Segment[]> {
    const res = await apiClient.get<ApiEnvelope<Segment[]>>("/segments", { params: { includeInactive: opts.includeInactive ? "true" : undefined, counts: opts.counts ? "true" : undefined } });
    return res.data.data;
  },
  async get(id: string): Promise<Segment> {
    const res = await apiClient.get<ApiEnvelope<Segment>>(`/segments/${id}`);
    return res.data.data;
  },
  async create(payload: CreateSegmentPayload): Promise<Segment> {
    const res = await apiClient.post<ApiEnvelope<Segment>>("/segments", payload);
    return res.data.data;
  },
  async update(id: string, payload: UpdateSegmentPayload): Promise<Segment> {
    const res = await apiClient.patch<ApiEnvelope<Segment>>(`/segments/${id}`, payload);
    return res.data.data;
  },
  async remove(id: string): Promise<{ id: string }> {
    const res = await apiClient.delete<ApiEnvelope<{ id: string }>>(`/segments/${id}`);
    return res.data.data;
  },
};
