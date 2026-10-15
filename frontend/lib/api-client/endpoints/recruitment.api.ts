import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  Application,
  ApplicationImportPreview,
  ApplicationImportResult,
  ApplicationListParams,
  ApplicationPage,
  ApplicationStatus,
  AssignApplicationsPayload,
  CreateApplicationPayload,
  CreateJobPayload,
  ImportField,
  Job,
  JobSummary,
  RecruitmentDistribution,
  UpdateJobPayload,
} from "../types/recruitment.types";

function cleanParams(params: ApplicationListParams = {}) {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
}

export const recruitmentApi = {
  async listJobs(): Promise<JobSummary[]> {
    const res = await apiClient.get<ApiEnvelope<JobSummary[]>>("/recruitment/jobs");
    return res.data.data;
  },

  async getJob(id: string): Promise<Job> {
    const res = await apiClient.get<ApiEnvelope<Job>>(`/recruitment/jobs/${id}`);
    return res.data.data;
  },

  async createJob(payload: CreateJobPayload): Promise<Job> {
    const res = await apiClient.post<ApiEnvelope<Job>>("/recruitment/jobs", payload);
    return res.data.data;
  },

  async updateJob(id: string, payload: UpdateJobPayload): Promise<Job> {
    const res = await apiClient.patch<ApiEnvelope<Job>>(`/recruitment/jobs/${id}`, payload);
    return res.data.data;
  },

  async listJobApplications(jobId: string, params?: ApplicationListParams): Promise<ApplicationPage> {
    const res = await apiClient.get<ApiEnvelope<ApplicationPage>>(`/recruitment/jobs/${jobId}/applications`, {
      params: cleanParams(params),
    });
    return res.data.data;
  },

  async listApplications(params?: ApplicationListParams): Promise<ApplicationPage> {
    const res = await apiClient.get<ApiEnvelope<ApplicationPage>>("/recruitment/applications", { params: cleanParams(params) });
    return res.data.data;
  },

  async createApplication(payload: CreateApplicationPayload): Promise<Application> {
    const res = await apiClient.post<ApiEnvelope<Application>>("/recruitment/applications", payload);
    return res.data.data;
  },

  async getApplication(id: string): Promise<Application> {
    const res = await apiClient.get<ApiEnvelope<Application>>(`/recruitment/applications/${id}`);
    return res.data.data;
  },

  async updateApplication(id: string, payload: { status?: ApplicationStatus; notes?: string }): Promise<Application> {
    const res = await apiClient.patch<ApiEnvelope<Application>>(`/recruitment/applications/${id}`, payload);
    return res.data.data;
  },

  async previewImport(jobId: string, file: File, columnMapping: Record<string, ImportField>): Promise<ApplicationImportPreview> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("columnMapping", JSON.stringify(columnMapping));
    const res = await apiClient.post<ApiEnvelope<ApplicationImportPreview>>(
      `/recruitment/jobs/${jobId}/applications/import/preview`,
      formData,
      { headers: { "Content-Type": "multipart/form-data" } },
    );
    return res.data.data;
  },

  async confirmImport(batchId: string): Promise<ApplicationImportResult> {
    const res = await apiClient.post<ApiEnvelope<ApplicationImportResult>>(`/recruitment/applications/import/${batchId}/confirm`);
    return res.data.data;
  },

  async assign(payload: AssignApplicationsPayload): Promise<{ assignedCount: number; unchangedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number; unchangedCount: number }>>(
      "/recruitment/applications/assign",
      payload,
    );
    return res.data.data;
  },

  async distribution(jobId?: string): Promise<RecruitmentDistribution> {
    const res = await apiClient.get<ApiEnvelope<RecruitmentDistribution>>("/recruitment/distribution", {
      params: jobId ? { jobId } : undefined,
    });
    return res.data.data;
  },

  async exportJobApplications(jobId: string): Promise<Blob> {
    const res = await apiClient.get(`/recruitment/jobs/${jobId}/applications/export`, { responseType: "blob" });
    return res.data as Blob;
  },
};
