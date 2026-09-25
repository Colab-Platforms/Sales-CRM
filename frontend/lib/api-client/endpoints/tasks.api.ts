import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { FollowUpTask } from "../types/tasks.types";

export const tasksApi = {
  async listMyFollowUps(): Promise<FollowUpTask[]> {
    const res = await apiClient.get<ApiEnvelope<FollowUpTask[]>>("/tasks/follow-ups");
    return res.data.data;
  },

  async completeTask(id: string): Promise<FollowUpTask> {
    const res = await apiClient.patch<ApiEnvelope<FollowUpTask>>(`/tasks/${id}/complete`);
    return res.data.data;
  },

  async snoozeTask(id: string, minutes: number): Promise<FollowUpTask> {
    const res = await apiClient.patch<ApiEnvelope<FollowUpTask>>(`/tasks/${id}/snooze`, { minutes });
    return res.data.data;
  },
};
