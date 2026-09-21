"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useWhatsAppTemplates } from "@/hooks/useWhatsAppTemplates";
import { getErrorMessage } from "@/lib/api-client/client";
import { useUpdateAutomationConfigMutation } from "@/lib/api-client/mutations/whatsapp-automations.mutations";
import { whatsappAutomationListQueryOptions } from "@/lib/api-client/queries/whatsapp-automations.queries";
import type { AutomationConfig } from "@/lib/api-client/types/whatsapp-automations.types";
import { AUTOMATION_DESCRIPTIONS, AUTOMATION_LABELS } from "@/lib/whatsapp-automation-labels";
import { formatDateTime } from "@/lib/order-status";
import { useAuthStore } from "@/stores/auth-store";

const NO_TEMPLATE = "__none__";

function AutomationRow({ config }: { config: AutomationConfig }) {
  const templatesQuery = useWhatsAppTemplates({ page: 1, pageSize: 100, status: "APPROVED" });
  const updateMutation = useUpdateAutomationConfigMutation();

  const templates = templatesQuery.data?.items ?? [];
  // The currently-assigned template might no longer be APPROVED (a provider sync can move it back
  // to REJECTED/DISABLED) - it still needs to show up in the picker so the admin can see and fix it.
  const templateOptions = config.template && !templates.some((t) => t.id === config.template!.id) ? [{ id: config.template.id, name: `${config.template.name} (${config.template.status})` }, ...templates] : templates;

  function handleTemplateChange(value: string | null) {
    updateMutation.mutate(
      { automationType: config.automationType, input: { templateId: !value || value === NO_TEMPLATE ? null : value } },
      { onError: (err) => toast.error(getErrorMessage(err, "Failed to update automation.")) },
    );
  }

  function handleToggle() {
    updateMutation.mutate(
      { automationType: config.automationType, input: { enabled: !config.enabled } },
      { onError: (err) => toast.error(getErrorMessage(err, "Failed to update automation.")) },
    );
  }

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{AUTOMATION_LABELS[config.automationType]}</p>
        <p className="text-xs text-muted-foreground">{AUTOMATION_DESCRIPTIONS[config.automationType]}</p>
      </TableCell>
      <TableCell>
        <Badge variant={config.enabled ? "default" : "secondary"}>{config.enabled ? "Enabled" : "Disabled"}</Badge>
      </TableCell>
      <TableCell className="min-w-56">
        <Select value={config.template?.id ?? NO_TEMPLATE} onValueChange={handleTemplateChange} items={Object.fromEntries([[NO_TEMPLATE, "No template selected"], ...templateOptions.map((t) => [t.id, t.name])])} disabled={updateMutation.isPending}>
          <SelectTrigger className="w-full" aria-label={`Template for ${AUTOMATION_LABELS[config.automationType]}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TEMPLATE}>No template selected</SelectItem>
            {templateOptions.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!config.template ? <p className="mt-1 text-xs text-muted-foreground">No template configured - this automation will not send.</p> : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{config.updatedBy ? `${config.updatedBy.name} · ${formatDateTime(config.updatedAt)}` : "Never changed"}</TableCell>
      <TableCell>
        <Button variant="outline" size="sm" onClick={handleToggle} disabled={updateMutation.isPending}>
          {config.enabled ? "Disable" : "Enable"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function AutomationsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading automations">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function WhatsAppAutomationsView() {
  const user = useAuthStore((s) => s.user);
  const query = useQuery({ ...whatsappAutomationListQueryOptions(), enabled: Boolean(user) });

  if (user && user.role !== "ADMIN") {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        Only an administrator can view or change WhatsApp lifecycle automations.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp Automations</h1>
        <p className="text-sm text-muted-foreground">
          Automatically send an approved WhatsApp template when one of these business events happens. Disabled, or with no template selected, an automation never sends anything.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle automations</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isPending ? (
            <AutomationsSkeleton />
          ) : query.error ? (
            <p role="alert" className="py-10 text-center text-sm text-destructive">
              {getErrorMessage(query.error, "Failed to load automations.")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(query.data ?? []).map((config) => (
                  <AutomationRow key={config.automationType} config={config} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
