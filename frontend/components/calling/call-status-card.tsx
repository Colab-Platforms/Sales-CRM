import { CheckCircle2, Loader2, PhoneCall, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CallingIdentity } from "./calling-identity";
import type { CallingIdentity as CallingIdentityData, CallStatus } from "@/lib/api-client/types/calls.types";

/**
 * `CallCardStatus` = the real backend `CallStatus` enum, plus one client-only bookend
 * ("INITIATING") for the moment before any response exists.
 *
 * `POST /api/calls` only ever returns `status: "INITIATED"` today — later states arrive through a
 * provider webhook the frontend doesn't poll for yet (no live status in this step). The rest of the
 * union exists purely so this component's shape doesn't have to change once that lands; this app
 * currently only ever passes "INITIATING" and "INITIATED" into it.
 */
export type CallCardStatus = "INITIATING" | CallStatus;

const STATUS_LABELS: Record<CallCardStatus, string> = {
  INITIATING: "Initiating…",
  INITIATED: "Call initiated",
  RINGING_AGENT: "Ringing you",
  AGENT_ANSWERED: "Connecting to customer",
  RINGING_CUSTOMER: "Ringing customer",
  CONNECTED: "Connected",
  COMPLETED: "Call completed",
  NO_ANSWER: "No answer",
  BUSY: "Busy",
  NOT_REACHABLE: "Not reachable",
  FAILED: "Call failed",
};

const TERMINAL: ReadonlySet<CallCardStatus> = new Set(["COMPLETED", "NO_ANSWER", "BUSY", "NOT_REACHABLE", "FAILED"]);

export interface CallStatusCardProps {
  status: CallCardStatus;
  customerName: string;
  callId?: string;
  callingIdentity?: CallingIdentityData | null;
  onDismiss?: () => void;
}

export function CallStatusCard({ status, customerName, callId, callingIdentity, onDismiss }: CallStatusCardProps) {
  const isInitiating = status === "INITIATING";
  const isFailed = status === "FAILED";
  const isTerminal = TERMINAL.has(status);

  return (
    <Card className={isFailed ? "border-destructive/30" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {isInitiating ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : isFailed ? (
            <XCircle className="size-4 text-destructive" aria-hidden="true" />
          ) : isTerminal ? (
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          ) : (
            <PhoneCall className="size-4 text-primary" aria-hidden="true" />
          )}
          {STATUS_LABELS[status]}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isInitiating ? (
          <p className="text-sm text-muted-foreground">Please wait while we connect the call.</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <div className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">Customer</dt>
              <dd className="text-sm font-medium">{customerName}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="text-sm font-medium">{STATUS_LABELS[status]}</dd>
            </div>
            {callId ? (
              <div className="space-y-0.5">
                <dt className="text-xs text-muted-foreground">Call ID</dt>
                <dd className="font-mono text-xs break-all">{callId}</dd>
              </div>
            ) : null}
          </dl>
        )}

        {callingIdentity ? <CallingIdentity identity={callingIdentity} /> : null}

        {onDismiss && !isInitiating ? (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
