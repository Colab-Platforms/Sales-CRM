"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@/lib/api-client/client";
import { whatsappConversationListQueryOptions } from "@/lib/api-client/queries/whatsapp-history.queries";
import { useForwardMessageMutation } from "@/lib/api-client/mutations/whatsapp-history.mutations";
import type { WhatsAppMessageHistoryItem } from "@/lib/api-client/types/whatsapp-history.types";

// Real forward through the EXISTING WhatsApp send infrastructure - picking a destination from the
// CRM's own existing conversation list, never a fake/second contact picker. Text only: see
// message-bubble.tsx's own comment on why media can't be forwarded with the current message schema.
export function ForwardMessageDialog({ message, onOpenChange }: { message: WhatsAppMessageHistoryItem | null; onOpenChange: (open: boolean) => void }) {
  const [search, setSearch] = useState("");
  const forward = useForwardMessageMutation();
  const conversations = useQuery({ ...whatsappConversationListQueryOptions({ page: 1, pageSize: 50, search: search.trim() || undefined }), enabled: Boolean(message) });
  const excludeLeadId = message?.customer?.leadId;
  const items = useMemo(() => (conversations.data?.items ?? []).filter((c) => c.leadId !== excludeLeadId), [conversations.data, excludeLeadId]);

  function handleForward(targetLeadId: string) {
    if (!message) return;
    forward.mutate(
      { id: message.id, targetLeadId },
      {
        onSuccess: () => {
          toast.success("Message forwarded.");
          onOpenChange(false);
        },
        onError: (err) => toast.error(getErrorMessage(err, "Could not forward the message.")),
      },
    );
  }

  return (
    <Dialog open={Boolean(message)} onOpenChange={onOpenChange}>
      {message ? (
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Forward message</DialogTitle>
            <DialogDescription className="line-clamp-2">{message.body}</DialogDescription>
          </DialogHeader>

          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customers…" aria-label="Search conversations to forward to" />

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {conversations.isPending ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No matching conversations.</p>
            ) : (
              items.map((c) => (
                <button
                  key={c.leadId}
                  type="button"
                  disabled={forward.isPending}
                  onClick={() => handleForward(c.leadId)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{c.mobile ?? "—"}</span>
                </button>
              ))
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={forward.isPending}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
