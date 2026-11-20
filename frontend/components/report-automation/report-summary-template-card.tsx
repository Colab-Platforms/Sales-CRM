"use client";

import { Button } from "@/components/ui/button";
import type { ReportAutomationConfigInput, SelectedTemplateStatus, SummaryTemplateStatus } from "@/lib/api-client/types/report-automation.types";
import { cn } from "@/lib/utils";
import { canUseTemplate, KIND_LABEL, selectedTemplateWarning, stateLabel, stateTone } from "./report-summary-template";

/**
 * The initial-message template: which Meta template the first WhatsApp message is meant to use, what each of its five variables fills, whether Meta has made it available, and what the template saved
 * today sends. Read-only status: nothing is selected or saved until the admin presses "Use this template" and then Save settings.
 */
export function ReportSummaryTemplateCard({ status, selected, form, isAdmin, onUse, onSync, syncing }: {
  status: SummaryTemplateStatus | undefined;
  selected: SelectedTemplateStatus | null | undefined;
  form: Pick<ReportAutomationConfigInput, "templateName" | "languageCode">;
  isAdmin: boolean;
  onUse: (name: string, language: string) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  if (!status) return null;
  const warning = selectedTemplateWarning(selected ?? null);
  const ready = status.state === "READY";
  return (
    <div className="space-y-2.5 rounded-md border bg-muted/20 p-3" data-testid="summary-template">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Initial message template</p>
          <p className="truncate font-mono text-xs text-muted-foreground" data-testid="summary-template-name">{status.name}</p>
        </div>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", stateTone(status))} data-testid="summary-template-state" data-state={status.state}>{stateLabel(status)}</span>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="summary-template-reason">{status.reason}</p>

      <details className="text-xs">
        <summary className="cursor-pointer font-medium">What each variable fills</summary>
        <ol className="mt-1.5 space-y-0.5" data-testid="summary-template-mapping">
          {status.mapping.map((m) => (
            <li key={m.position} className="flex flex-wrap gap-x-2">
              <span className="w-10 shrink-0 font-mono text-muted-foreground">{`{{${m.position}}}`}</span>
              <span className="font-mono">{m.variable}</span>
              <span className="text-muted-foreground">- {m.meaning}</span>
            </li>
          ))}
        </ol>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        {canUseTemplate(status, form) ? <Button type="button" size="sm" onClick={() => onUse(status.name, status.language!)} data-testid="use-summary-template">Use this template</Button> : null}
        {ready && status.selected ? <span className="text-xs font-medium text-emerald-600" data-testid="summary-template-selected">In use</span> : null}
        {!ready && isAdmin ? <Button type="button" size="sm" variant="outline" onClick={onSync} disabled={syncing} data-testid="summary-template-sync">{syncing ? "Syncing…" : "Check Meta (Sync templates)"}</Button> : null}
      </div>

      {selected ? (
        <p className="border-t pt-2 text-xs text-muted-foreground" data-testid="selected-template-sends">
          Saved template <span className="font-mono">{selected.name}</span> sends: <span className="text-foreground">{KIND_LABEL[selected.sends]}</span>
          {!status.selected && !ready ? ". It keeps being used until the new template is approved, synced and selected." : "."}
        </p>
      ) : null}
      {warning ? <p role="alert" className="text-xs font-medium text-destructive" data-testid="selected-template-warning">{warning}</p> : null}
    </div>
  );
}
