import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attendanceApi } from "../endpoints/attendance.api";
import { attendanceKeys } from "../queries/attendance.queries";
import type { ManualWorkStatus, MyShift } from "../types/attendance.types";

export function useStartShiftMutation() {
  const queryClient = useQueryClient();

  return useMutation<MyShift>({
    mutationFn: attendanceApi.start,
    onSuccess: (data) => queryClient.setQueryData(attendanceKeys.me(), data),
  });
}

export function useSetWorkStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation<MyShift, unknown, ManualWorkStatus>({
    mutationFn: attendanceApi.setStatus,
    onSuccess: (data) => queryClient.setQueryData(attendanceKeys.me(), data),
  });
}

export function useEndShiftMutation() {
  const queryClient = useQueryClient();

  return useMutation<void>({
    mutationFn: attendanceApi.end,
    // The server answers with no body, so refetch the (now ended) shift.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: attendanceKeys.me() }),
  });
}
