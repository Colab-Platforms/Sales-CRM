"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

// Part 2 (WhatsApp Inbox): the plain <Select> this replaced pins its popup to the trigger's own
// width (`w-(--anchor-width)` in select.tsx) and force-truncates item text with `whitespace-nowrap` -
// fine for a handful of short options, but a real template name ("webinar_registration_confirmation")
// was getting clipped with no way to see the rest, and there was no way to search a longer template
// list at all. Built on DropdownMenu instead (its popup is only `min-w`, and item text isn't forced
// to one line), which gives a wide, scrollable, searchable list - the same template data and the same
// caller-owned selection/preview flow, never a second template-loading path.
export function TemplatePicker({
  templates,
  value,
  onChange,
  disabled,
  placeholder = "Select an approved template",
}: {
  templates: WhatsAppTemplate[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = templates.find((t) => t.id === value) ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => t.name.toLowerCase().includes(q));
  }, [templates, search]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <DropdownMenuTrigger render={<Button type="button" variant="outline" disabled={disabled} className="h-auto min-h-9 w-full justify-between py-1.5 font-normal" />}>
        {/* Wraps rather than truncates - a long approved template name must stay fully readable here too, not just in the list below. */}
        <span className="text-left break-words whitespace-normal">{selected ? selected.name : placeholder}</span>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(30rem,90vw)] p-0">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Keeps normal typing (including letters a menu would otherwise treat as type-ahead
              // navigation, and Enter/Arrow keys) inside this input instead of the menu's own handlers.
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search templates…"
              className="h-8 pl-7 text-sm"
              aria-label="Search templates"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="p-3 text-center text-sm text-muted-foreground">No templates match &ldquo;{search}&rdquo;.</p>
          ) : (
            filtered.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                className="flex-col items-start gap-0.5 py-2"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="font-medium break-words whitespace-normal">{t.name}</span>
                  <Badge variant="secondary" className="shrink-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    Approved
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {PROVIDER_LABELS[t.provider] ?? t.provider} · {t.variables.length} variable{t.variables.length === 1 ? "" : "s"}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
