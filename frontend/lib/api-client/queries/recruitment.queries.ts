import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { recruitmentApi } from "../endpoints/recruitment.api";
import type { ApplicationListParams } from "../types/recruitment.types";

export const recruitmentKeys = {
  all: ["recruitment"] as const,
  jobs: () => [...recruitmentKeys.all, "jobs"] as const,
  job: (id: string) => [...recruitmentKeys.all, "jobs", id] as const,
  jobApplications: (id: string, params?: ApplicationListParams) =>
    [...recruitmentKeys.all, "jobs", id, "applications", params ?? {}] as const,
  applications: (params?: ApplicationListParams) => [...recruitmentKeys.all, "applications", params ?? {}] as const,
  application: (id: string) => [...recruitmentKeys.all, "application", id] as const,
  distribution: (jobId?: string) => [...recruitmentKeys.all, "distribution", jobId ?? "all"] as const,
};

export function jobsQueryOptions() {
  return queryOptions({ queryKey: recruitmentKeys.jobs(), queryFn: recruitmentApi.listJobs });
}

export function jobQueryOptions(id: string) {
  return queryOptions({ queryKey: recruitmentKeys.job(id), queryFn: () => recruitmentApi.getJob(id) });
}

export function jobApplicationsQueryOptions(jobId: string, params?: ApplicationListParams) {
  return queryOptions({
    queryKey: recruitmentKeys.jobApplications(jobId, params),
    queryFn: () => recruitmentApi.listJobApplications(jobId, params),
    placeholderData: keepPreviousData,
  });
}

export function applicationsQueryOptions(params?: ApplicationListParams) {
  return queryOptions({
    queryKey: recruitmentKeys.applications(params),
    queryFn: () => recruitmentApi.listApplications(params),
    placeholderData: keepPreviousData,
  });
}

export function applicationQueryOptions(id: string) {
  return queryOptions({ queryKey: recruitmentKeys.application(id), queryFn: () => recruitmentApi.getApplication(id) });
}

export function distributionQueryOptions(jobId?: string) {
  return queryOptions({ queryKey: recruitmentKeys.distribution(jobId), queryFn: () => recruitmentApi.distribution(jobId) });
}
