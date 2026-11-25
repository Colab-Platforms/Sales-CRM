"use client";

import { useRouter } from "next/navigation";
import { Headphones } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Call } from "@/lib/api-client/types/calling.types";
import { callRecordingsHref } from "@/lib/call-recordings-href";
import { recordedCalls } from "./recording-cell";

/**
 * The Recording column of the Abandoned Leads table (admin / manager only). Listening and downloading live on the Call Recordings page; this opens it already filtered to this
 * lead, so every recording of the lead (all calls, by every telecaller) is there. A lead with no recording shows "No recording".
 */
export function ViewRecordingsLink({ leadId, calls }: { leadId: string; calls: Call[] }) {
  const router = useRouter();
  const count = recordedCalls(calls).length;
  if (count === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="no-recording">
        No recording
      </span>
    );
  }
  return (
    <Button type="button" variant="outline" size="sm" data-testid="view-recordings" onClick={() => router.push(callRecordingsHref(leadId))}>
      <Headphones className="size-3.5" />
      View Recordings{count > 1 ? ` (${count})` : ""}
    </Button>
  );
}
