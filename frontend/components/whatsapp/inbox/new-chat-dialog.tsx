"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, Search, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCustomersList } from "@/hooks/useCustomers";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// Part 1/5 (WhatsApp page): any customer can be reached from here even with zero prior WhatsApp
// messages - the conversation list itself is built only from existing WhatsAppMessage rows (see
// whatsapp.service.ts's listConversations), so a brand-new contact structurally cannot appear there
// until a real message exists. This picker is the "selectable even with no conversation" surface:
// it searches the same Customers data (no second contact model), and picking someone hands their
// leadId straight to the existing SendWhatsAppDialog - no conversation/message row is created here,
// only once a real template is actually sent.
export function NewChatDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (customer: { leadId: string; name: string; mobile: string | null }) => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      setSearchInput("");
      setSearch("");
    }
  }, [open]);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setSearch(value), SEARCH_DEBOUNCE_MS);
  }

  const { data, isLoading, error } = useCustomersList({ page: 1, pageSize: PAGE_SIZE, search: search || undefined }, { enabled: open });
  // A template can only ever reach a real WhatsApp number - a customer with none on file is shown
  // as disabled rather than hidden, so it's clear why they can't be picked.
  const items = data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Start a WhatsApp chat
          </DialogTitle>
          <DialogDescription>Find any customer and send them an approved template - no existing conversation needed.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search customers by name, phone, email…"
            className="pl-8"
            aria-label="Search customers"
          />
        </div>

        <div className="max-h-80 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-2 py-2" aria-busy="true" aria-label="Loading customers">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : error ? (
            <p role="alert" className="py-4 text-center text-sm text-destructive">
              {error}
            </p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Users className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{search ? "No customers match your search." : "No customers yet."}</p>
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((customer) => {
                const disabled = !customer.mobile;
                return (
                  <li key={customer.leadId}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onSelect({ leadId: customer.leadId, name: customer.name, mobile: customer.mobile })}
                      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{customer.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{customer.mobile ?? "No phone on file"} · {customer.leadNumber}</p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
