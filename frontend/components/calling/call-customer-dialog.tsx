"use client";

import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CallingIdentity } from "./calling-identity";
import { CallStatusCard } from "./call-status-card";
import type { CallFailure } from "@/hooks/useCallCustomer";

export interface CallCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName: string;
  customerMobile: string | null;
  isPending: boolean;
  failure: CallFailure | null;
  onStartCall: () => void;
  onRetry: () => void;
}

/**
 * Purely controlled/presentational — all state (open, pending, failure) lives in useCallCustomer,
 * so a request already in flight when this dialog closes still delivers its result there.
 *
 * The API request is made only from the Start Call button's onClick (via onStartCall), never as a
 * side effect of the dialog opening.
 */
export function CallCustomerDialog({
  open,
  onOpenChange,
  customerName,
  customerMobile,
  isPending,
  failure,
  onStartCall,
  onRetry,
}: CallCustomerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-[420px]" showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="size-4" aria-hidden="true" />
            Call Customer
          </DialogTitle>
        </DialogHeader>

        {failure ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <p className="text-sm text-destructive">{failure.message}</p>
            {failure.code ? <p className="font-mono text-xs text-muted-foreground">Error code: {failure.code}</p> : null}
          </div>
        ) : isPending ? (
          <CallStatusCard status="INITIATING" customerName={customerName} />
        ) : (
          <div className="space-y-4 py-1">
            <div>
              <p className="font-semibold">{customerName}</p>
              <p className="text-sm text-muted-foreground">{customerMobile ?? "No mobile number on file"}</p>
            </div>
            <CallingIdentity identity={null} pendingMessage="Shown once the call starts" />
            <p className="text-sm text-muted-foreground">
              You will first be connected to the business calling system, then to the customer.
            </p>
          </div>
        )}

        <DialogFooter>
          {failure ? (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" onClick={onRetry}>
                Try Again
              </Button>
            </>
          ) : !isPending ? (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={onStartCall} disabled={!customerMobile}>
                <Phone data-icon="inline-start" />
                Start Call
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
