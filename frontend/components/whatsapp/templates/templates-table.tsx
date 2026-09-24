"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import { TemplateStatusBadge } from "./template-status-badge";
import type { WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

const COLUMN_COUNT = 6;
const HEADERS = ["Name", "Provider", "Category", "Language", "Variables", "Status"];

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

interface TemplatesTableProps {
  items: WhatsAppTemplate[];
  isFetching: boolean;
  onSelect: (template: WhatsAppTemplate) => void;
}

export function TemplatesTable({ items, isFetching, onSelect }: TemplatesTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((t) => (
          <TableRow key={t.id} className="cursor-pointer" onClick={() => onSelect(t)}>
            <TableCell>
              <span className="font-medium">{t.name}</span>
              {t.providerTemplateId ? <div className="text-xs text-muted-foreground">{t.providerTemplateId}</div> : null}
            </TableCell>
            <TableCell className="text-muted-foreground">{PROVIDER_LABELS[t.provider] ?? t.provider}</TableCell>
            <TableCell className="text-muted-foreground">{t.category ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{t.language}</TableCell>
            <TableCell className="text-muted-foreground">{t.variables.length > 0 ? t.variables.length : "—"}</TableCell>
            <TableCell>
              <TemplateStatusBadge status={t.status} />
            </TableCell>
          </TableRow>
        ))}
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={COLUMN_COUNT} className="py-10 text-center text-sm text-muted-foreground">
              No templates match these filters.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
