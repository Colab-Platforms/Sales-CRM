"use client";

import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappStarredMessagesQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";

const TIME_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// The "Starred messages" view every real WhatsApp has, built on the exact same WhatsAppMessageUserState
// rows the message bubble's Star action writes - never a second starring mechanism.
export function StarredMessagesDialog({ leadId, open, onOpenChange }: { leadId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const query = useQuery({ ...whatsappStarredMessagesQueryOptions(leadId), enabled: open });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="size-4 fill-current" />
            Starred messages
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-96 space-y-2 overflow-y-auto">
          {query.isPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : query.isError ? (
            <p role="alert" className="py-6 text-center text-sm text-destructive">
              {getErrorMessage(query.error, "Failed to load starred messages.")}
            </p>
          ) : query.data!.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No starred messages in this conversation yet.</p>
          ) : (
            query.data!.map((m) => (
              <div key={m.id} className="rounded-lg border p-3 text-sm">
                <p className="whitespace-pre-wrap break-words">{m.body || (m.template ? `Template: ${m.template.name}` : "(message)")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {m.direction === "OUTBOUND" ? "You" : "Customer"} · {TIME_FORMAT.format(new Date(m.createdAt))}
                </p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
