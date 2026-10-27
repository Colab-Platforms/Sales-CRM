import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { MatrixQuery, PerformanceMatrix } from "../types/performance-matrix.types";

export const performanceMatrixApi = {
  async get(q: MatrixQuery): Promise<PerformanceMatrix> {
    const res = await apiClient.get<ApiEnvelope<PerformanceMatrix>>("/performance-matrix", {
      params: { date: q.date, ...(q.salespersonId ? { salespersonId: q.salespersonId } : {}), ...(q.managerId ? { managerId: q.managerId } : {}) },
    });
    return res.data.data;
  },
};
