import { useMutation, useQueryClient } from "@tanstack/react-query";
import { recruitmentApi } from "../endpoints/recruitment.api";
import { recruitmentKeys } from "../queries/recruitment.queries";
import type {
  Application,
  ApplicationImportPreview,
  ApplicationImportResult,
  ApplicationStatus,
  AssignApplicationsPayload,
  CreateApplicationPayload,
  CreateJobPayload,
  ImportField,
  Job,
  UpdateJobPayload,
} from "../types/recruitment.types";

export function useCreateJobMutation() {
  const queryClient = useQueryClient();
  return useMutation<Job, unknown, CreateJobPayload>({
    mutationFn: (payload) => recruitmentApi.createJob(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recruitmentKeys.jobs() }),
  });
}

export function useUpdateJobMutation() {
  const queryClient = useQueryClient();
  return useMutation<Job, unknown, { id: string; payload: UpdateJobPayload }>({
    mutationFn: ({ id, payload }) => recruitmentApi.updateJob(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recruitmentKeys.all }),
  });
}

export function usePreviewApplicationImportMutation(jobId: string) {
  return useMutation<ApplicationImportPreview, unknown, { file: File; columnMapping: Record<string, ImportField> }>({
    mutationFn: ({ file, columnMapping }) => recruitmentApi.previewImport(jobId, file, columnMapping),
  });
}

export function useConfirmApplicationImportMutation() {
  const queryClient = useQueryClient();
  return useMutation<ApplicationImportResult, unknown, string>({
    mutationFn: (batchId) => recruitmentApi.confirmImport(batchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recruitmentKeys.all }),
  });
}

export function useAssignApplicationsMutation() {
  const queryClient = useQueryClient();
  return useMutation<{ assignedCount: number; unchangedCount: number }, unknown, AssignApplicationsPayload>({
    mutationFn: (payload) => recruitmentApi.assign(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recruitmentKeys.all }),
  });
}

export function useUpdateApplicationMutation() {
  const queryClient = useQueryClient();
  return useMutation<Application, unknown, { id: string; payload: { status?: ApplicationStatus; notes?: string } }>({
    mutationFn: ({ id, payload }) => recruitmentApi.updateApplication(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recruitmentKeys.all }),
  });
}

export function useCreateApplicationMutation() {
  const queryClient = useQueryClient();
  return useMutation<Application, unknown, CreateApplicationPayload>({
    mutationFn: (payload) => recruitmentApi.createApplication(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recruitmentKeys.all }),
  });
}
