"use client";

import { useState } from "react";
import axios from "axios";
import { useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@/lib/api-client/client";
import { useInitiateCallMutation } from "@/lib/api-client/mutations/calls.mutations";
import { auditKeys } from "@/lib/api-client/queries/audit.queries";
import { leadKeys } from "@/lib/api-client/queries/lead.queries";
import type { ApiEnvelope } from "@/lib/api-client/types/common.types";
import type { InitiateCallErrorData, InitiateCallResult } from "@/lib/api-client/types/calls.types";

export interface CallFailure {
  message: string;
  /** Kept for debugging (e.g. reporting to support); never a raw provider payload. */
  code?: string;
}

function describeFailure(error: unknown): CallFailure {
  // A request that never reached the server (offline, DNS, CORS) has no `response` at all.
  if (axios.isAxiosError(error) && !error.response) {
    return { message: "Network error. Please check your connection and try again." };
  }

  const envelope = axios.isAxiosError(error)
    ? (error.response?.data as Partial<ApiEnvelope<InitiateCallErrorData>> | undefined)
    : undefined;

  return {
    message: getErrorMessage(error, "Unable to start the call."),
    code: envelope?.data?.code,
  };
}

/**
 * Owns the whole "Call Customer" lifecycle for one lead: the confirmation dialog's open state, the
 * `POST /api/calls` mutation, and the resulting status once a call has actually been initiated.
 *
 * Lives above the dialog (not inside it) so a request that's in flight when the dialog is closed
 * still delivers its result here instead of being silently dropped with the dialog.
 */
export function useCallCustomer(leadId: string) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [failure, setFailure] = useState<CallFailure | null>(null);
  const [result, setResult] = useState<InitiateCallResult | null>(null);
  const mutation = useInitiateCallMutation();

  function openDialog() {
    setFailure(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setFailure(null);
  }

  function startCall() {
    if (mutation.isPending) return; // belt-and-braces alongside the disabled Start Call button
    setFailure(null);
    mutation.mutate(
      { leadId },
      {
        onSuccess: (data) => {
          setResult(data);
          setDialogOpen(false);
          // The call itself may not have produced a lead-activity entry yet, but this keeps both
          // fresh for whenever it does, rather than requiring a manual page reload to see it.
          queryClient.invalidateQueries({ queryKey: leadKeys.detail(leadId) });
          queryClient.invalidateQueries({ queryKey: [...auditKeys.all, "customer", leadId] });
        },
        onError: (error) => setFailure(describeFailure(error)),
      },
    );
  }

  return {
    dialogOpen,
    openDialog,
    closeDialog,
    startCall,
    retry: () => setFailure(null), // back to the confirmation screen, not an immediate re-fire
    isPending: mutation.isPending,
    failure,
    result,
    dismissResult: () => setResult(null),
  };
}

export type UseCallCustomerReturn = ReturnType<typeof useCallCustomer>;
