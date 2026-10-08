import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  AttendanceReport,
  ManualWorkStatus,
  MyShift,
  TeamStatus,
} from "../types/attendance.types";

export const attendanceApi = {
  async start(): Promise<MyShift> {
    const res = await apiClient.post<ApiEnvelope<MyShift>>("/attendance/start");
    return res.data.data;
  },

  async heartbeat(): Promise<void> {
    await apiClient.post<ApiEnvelope<null>>("/attendance/heartbeat");
  },

  async end(): Promise<void> {
    await apiClient.post<ApiEnvelope<null>>("/attendance/end");
  },

  async setStatus(status: ManualWorkStatus): Promise<MyShift> {
    const res = await apiClient.post<ApiEnvelope<MyShift>>("/attendance/status", { status });
    return res.data.data;
  },

  async getMine(): Promise<MyShift> {
    const res = await apiClient.get<ApiEnvelope<MyShift>>("/attendance/me");
    return res.data.data;
  },

  async getTeam(): Promise<TeamStatus> {
    const res = await apiClient.get<ApiEnvelope<TeamStatus>>("/attendance/team");
    return res.data.data;
  },

  async getReport(params: { date?: string; userId?: string }): Promise<AttendanceReport> {
    const res = await apiClient.get<ApiEnvelope<AttendanceReport>>("/attendance/report", { params });
    return res.data.data;
  },
};
