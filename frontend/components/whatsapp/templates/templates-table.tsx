"use client";

import { Copy, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { TemplateStatusBadge } from "./template-status-badge";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

const COLUMN_COUNT = 7;
const HEADERS = ["Name", "Provider", "Category", "Language", "Variables", "Status", "Actions"];

export function TemplatesTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading templates">
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, i) => (
          <TableRow key={i}>
            {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
              <TableCell key={j}>
                <div className="h-4 w-full max-w-24 animate-pulse rounded bg-muted" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function copyProviderId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast.success("Provider template ID copied.");
  } catch {
    toast.error("Could not copy. Select and copy it manually.");
  }
}

interface TemplatesTableProps {
  items: WhatsAppTemplate[];
  isFetching: boolean;
  canManage: boolean;
  onSelect: (template: WhatsAppTemplate) => void;
  onEdit: (template: WhatsAppTemplate) => void;
  onDelete: (template: WhatsAppTemplate) => void;
}

export function TemplatesTable({ items, isFetching, canManage, onSelect, onEdit, onDelete }: TemplatesTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.slice(0, canManage ? undefined : -1).map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((t) => (
          <TableRow key={t.id} className="cursor-pointer" onClick={() => onSelect(t)}>
            <TableCell>
              <span className="font-medium">{t.name}</span>
              {t.providerTemplateId ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void copyProviderId(t.providerTemplateId!);
                  }}
                  className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  title="Copy provider template ID"
                >
                  <span className="max-w-[160px] truncate font-mono">{t.providerTemplateId}</span>
                  <Copy className="size-3 shrink-0" />
                </button>
              ) : null}
            </TableCell>
            <TableCell className="text-muted-foreground">{PROVIDER_LABELS[t.provider] ?? t.provider}</TableCell>
            <TableCell className="text-muted-foreground">{t.category ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{t.language}</TableCell>
            <TableCell className="text-muted-foreground">{t.variables.length > 0 ? t.variables.length : "—"}</TableCell>
            <TableCell>
              <TemplateStatusBadge status={t.status} />
              <div className="mt-0.5 text-[11px] text-muted-foreground">Updated {formatDate(t.updatedAt)}</div>
            </TableCell>
            {canManage ? (
              <TableCell onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`} />}>
                    <MoreVertical />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onSelect(t)}>View</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEdit(t)} className="gap-2">
                      <Pencil className="size-3.5" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onDelete(t)} className="gap-2 text-destructive focus:text-destructive">
                      <Trash2 className="size-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={canManage ? COLUMN_COUNT : COLUMN_COUNT - 1} className="py-10 text-center text-sm text-muted-foreground">
              No templates match these filters.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
