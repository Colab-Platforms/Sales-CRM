"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Send, Trash2 } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import { reportAutomationApi } from "@/lib/api-client/endpoints/report-automation.api";
import type { ReportAutomationConfigInput, ReportMessagePart, ReportMode, ReportOptions } from "@/lib/api-client/types/report-automation.types";
import { MAX_RECIPIENTS, REPORT_MODE_LABEL, REPORT_TEMPLATE_NAME, STATUS_LABEL, TIMEZONES, normalizeRecipient, validateForm, validateRecipients } from "./report-automation-form";

const keys = { config: ["report-automation", "config"] as const, history: ["report-automation", "deliveries"] as const, status: ["report-automation", "status"] as const };

const OPTION_LABELS: [keyof ReportOptions, string][] = [
  ["teamSummary", "Team summary"],
  ["sales", "Orders, revenue and cancelled orders"],
  ["leads", "Leads handled and conversion"],
  ["calls", "Calls and talk time"],
  ["followUps", "Pending follow-ups"],
];

const todayIn = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST" : "-");

/** "daily_team_report1 - META - en - APPROVED": everything that identifies the template the report will really use. */
export const templateLabel = (t: { name: string; provider: string; language: string; status: string }): string => `${t.name} - ${t.provider} - ${t.language} - ${t.status}`;

/** One message of a recipient (the text or the Excel file): its own status, attempts, last attempt, reason, provider id and Retry. */
function PartCell({ part, testId, onRetry, busy }: { part: ReportMessagePart & { nextAttemptAt?: string | null }; testId: string; onRetry: () => void; busy: boolean }) {
  if (part.status === "SKIPPED" && !part.error) return <span className="text-xs text-muted-foreground">{STATUS_LABEL.SKIPPED}</span>;
  const tone = part.status === "FAILED" ? "text-destructive" : part.status === "UNCERTAIN" ? "text-amber-600" : part.status === "DELIVERED" || part.status === "READ" ? "text-emerald-600" : "";
  return (
    <div className="max-w-xs space-y-0.5 whitespace-normal text-xs" data-testid={`part-${testId}`}>
      <p className={`text-sm font-medium ${tone}`}>{STATUS_LABEL[part.status] ?? part.status}</p>
      <p className="text-muted-foreground">Attempts: {part.attempts}{part.lastAttemptAt ? ` | last ${fmt(part.lastAttemptAt)}` : ""}</p>
      {part.error ? <p className={part.status === "SKIPPED" ? "text-muted-foreground" : "text-destructive"}>{part.error}</p> : null}
      {part.status === "FAILED" && part.nextAttemptAt ? <p>Next automatic attempt {fmt(part.nextAttemptAt)}.</p> : null}
      {part.status === "UNCERTAIN" ? <p>Not re-sent automatically; check the phone before sending again.</p> : null}
      {part.status === "PENDING" ? <p className="text-muted-foreground">Waiting for the notification to be tried.</p> : null}
      {part.deliveredAt ? <p>Delivered {fmt(part.deliveredAt)}</p> : null}
      {part.readAt ? <p>Read {fmt(part.readAt)}</p> : null}
      {part.providerMessageId ? <p className="break-all text-muted-foreground">Provider id {part.providerMessageId}</p> : null}
      {part.canRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={busy} data-testid={`retry-${testId}`}>Retry {testId === "excel" ? "Excel" : testId === "detail" ? "detailed report" : "notification"}</Button> : null}
    </div>
  );
}

export function ReportAutomationView() {
  const role = useAuthStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const allowed = role === "ADMIN" || role === "MANAGER";

  const config = useQuery({ queryKey: keys.config, queryFn: reportAutomationApi.getConfig, enabled: allowed });
  const history = useQuery({ queryKey: keys.history, queryFn: () => reportAutomationApi.deliveries(1, 20), enabled: allowed, refetchInterval: 30_000 });
  const status = useQuery({ queryKey: keys.status, queryFn: reportAutomationApi.status, enabled: allowed, refetchInterval: 60_000 });

  // The form is the saved settings until the user edits something (a draft); saving clears the draft so the form shows what the server stored.
  const [draft, setDraft] = useState<ReportAutomationConfigInput | null>(null);
  const c = config.data;
  const saved: ReportAutomationConfigInput | null = c ? { enabled: c.enabled, recipients: c.recipients.map((r) => ({ name: r.name ?? "", phone: r.phone })), sendTime: c.sendTime, timezone: c.timezone, reportFor: c.reportFor, dataDate: c.dataDate, templateName: c.templateName ?? "", languageCode: c.languageCode, options: c.options, includedUserIds: c.includedUserIds, sendText: c.sendText, sendExcel: c.sendExcel } : null;
  const form = draft ?? saved;

  const [date, setDate] = useState("");
  const previewDate = date; // empty = the SAVED selection (today / yesterday / specific date / previous 7 days)
  const preview = useQuery({ queryKey: ["report-automation", "preview", previewDate, config.data?.updatedAt], queryFn: () => reportAutomationApi.preview(previewDate || undefined), enabled: allowed && Boolean(config.data) });

  const save = useMutation({
    mutationFn: (input: ReportAutomationConfigInput) => reportAutomationApi.saveConfig({ ...input, recipients: input.recipients.map((r) => ({ ...(r.name?.trim() ? { name: r.name.trim() } : {}), phone: normalizeRecipient(r.phone) })) }),
    onSuccess: (saved) => {
      toast.success("Settings saved");
      queryClient.setQueryData(keys.config, saved);
      setDraft(null); // show the saved (normalised) values
    },
    onError: (e) => toast.error(getErrorMessage(e, "Could not save the settings.")),
  });

  const [confirming, setConfirming] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const retry = useMutation({
    mutationFn: ({ id, part }: { id: string; part: "TEXT" | "DETAIL" | "DOCUMENT" }) => reportAutomationApi.retry(id, part),
    onSuccess: (r, v) => {
      const p = v.part === "DOCUMENT" ? r.document : v.part === "DETAIL" ? r.detail : r;
      if (p.status === "SENT") toast.success(v.part === "DOCUMENT" ? "Excel file accepted by WhatsApp" : v.part === "DETAIL" ? "Detailed report accepted by WhatsApp" : "Template notification accepted by WhatsApp");
      else toast.error(p.error ?? STATUS_LABEL[p.status]);
    },
    onError: (e) => toast.error(getErrorMessage(e, "The retry could not be sent.")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.history }),
  });
  const test = useMutation({
    mutationFn: () => reportAutomationApi.testSend(),
    onSuccess: (d) => {
      const ok = (p: ReportMessagePart) => p.status === "SENT" || p.status === "DELIVERED" || p.status === "READ";
      const total = d.recipients.length;
      const kinds: [string, (r: (typeof d.recipients)[number]) => ReportMessagePart][] = [["Template notification", (r) => r], ["Detailed report", (r) => r.detail], ["Excel", (r) => r.document]];
      const active = kinds.filter(([, get]) => d.recipients.some((r) => get(r).status !== "SKIPPED"));
      const counts = active.map(([label, get]) => ({ label, n: d.recipients.filter((r) => ok(get(r))).length }));
      const reasons = [...new Set(d.recipients.flatMap((r) => [r.error, r.detail.error, r.document.error]).filter((x): x is string => Boolean(x)))];
      const parts = counts.map((c) => `${c.label}: ${c.n} of ${total} accepted`).join(" | ");
      setTestResult({ ok: counts.every((c) => c.n === total), text: `${parts}.${reasons.length > 0 ? ` Reason: ${reasons.join(" / ")}` : " Accepted is not delivered - the history shows Delivered / Read when WhatsApp reports it."}` });
      queryClient.invalidateQueries({ queryKey: keys.history });
    },
    onError: (e) => setTestResult({ ok: false, text: getErrorMessage(e, "The test could not be sent.") }),
    onSettled: () => setConfirming(false),
  });

  if (!allowed) {
    return (
      <div role="alert" className="py-10 text-center text-sm text-muted-foreground" data-testid="report-automation-forbidden">
        This section is available to Admin and Manager users only.
      </div>
    );
  }
  if (config.isLoading || !form) return <p className="py-10 text-sm text-muted-foreground">Loading…</p>;
  if (config.error) return <p role="alert" className="py-10 text-sm text-destructive">{getErrorMessage(config.error, "Failed to load the settings.")}</p>;

  const errors = validateForm(form);
  const rowErrors = validateRecipients(form.recipients, form.enabled);
  const setRow = (i: number, patch: { name?: string; phone?: string }) => set("recipients", form.recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const templates = status.data?.whatsapp.templates ?? [];
  const set = <K extends keyof ReportAutomationConfigInput>(k: K, v: ReportAutomationConfigInput[K]) => setDraft({ ...form, [k]: v });
  const norm = (rs: { name?: string | null; phone: string }[]) => rs.map((r) => [(r.name ?? "").trim(), normalizeRecipient(r.phone)]);
  const dirty = JSON.stringify({ ...form, recipients: norm(form.recipients) }) !== JSON.stringify({ enabled: config.data!.enabled, recipients: norm(config.data!.recipients), sendTime: config.data!.sendTime, timezone: config.data!.timezone, reportFor: config.data!.reportFor, dataDate: config.data!.dataDate, templateName: config.data!.templateName ?? "", languageCode: config.data!.languageCode, options: config.data!.options, includedUserIds: config.data!.includedUserIds, sendText: config.data!.sendText, sendExcel: config.data!.sendExcel });

  return (
    <div className="space-y-6">
      <PageHeader title="WhatsApp Report Automation" description="Send a daily telecaller performance report to one or more WhatsApp numbers. Admin: all telecallers. Manager: your team." />

      <Card>
        <CardHeader><CardTitle>Saved schedule</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm" data-testid="saved-schedule">
          <p className={config.data!.enabled ? "font-medium text-emerald-600" : "font-medium text-amber-600"} data-testid="saved-state">
            Saved: automatic sending is {config.data!.enabled ? "ON" : "OFF"} - {config.data!.sendTime} {config.data!.timezone}, {config.data!.reportFor === "DATE" ? `report data for ${config.data!.dataDate}` : REPORT_MODE_LABEL[config.data!.reportFor]?.toLowerCase()}, {config.data!.recipients.length} recipient{config.data!.recipients.length === 1 ? "" : "s"}
            {config.data!.templateName ? `, template ${config.data!.templateName} (${config.data!.languageCode})` : ", no template"}.
          </p>
          <p className="text-xs text-muted-foreground">The scheduler always uses these saved settings, never unsaved edits. A report goes out at the saved time in the saved timezone. If you save after today&apos;s time has passed, the first report is the next occurrence; if the server is down for more than 3 hours past the time, that report is recorded as Missed and not sent late.</p>
          {dirty ? <p role="alert" className="font-medium text-amber-600" data-testid="unsaved-warning">You have changes that are NOT saved yet{form.enabled !== config.data!.enabled ? ` (automatic sending is ${form.enabled ? "ticked" : "unticked"} here but ${config.data!.enabled ? "ON" : "OFF"} in the saved settings)` : ""}. Nothing changes until you click Save settings.</p> : null}
          {status.data ? (
            <>
              <p data-testid="last-heartbeat">Last scheduler heartbeat: {status.data.scheduler.lastTickAt ? `${fmt(status.data.scheduler.lastTickAt)} (${status.data.scheduler.lastSource === "cron" ? "external cron" : "server timer"})` : "never"}.</p>
              <p data-testid="last-scheduled">
                Last scheduled attempt:{" "}
                {status.data.lastScheduled
                  ? `report for ${status.data.lastScheduled.reportDate}, ${STATUS_LABEL[status.data.lastScheduled.status] ?? status.data.lastScheduled.status}${status.data.lastScheduled.recipients.find((r) => r.error || r.detail.error || r.document.error) ? " - " + (status.data.lastScheduled.recipients.flatMap((r) => [r.error, r.detail.error, r.document.error]).find(Boolean) as string) : ""}`
                  : "none yet. Manual test sends are listed separately in the history."}
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Readiness</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm" data-testid="readiness">
          {status.isLoading ? <p className="text-muted-foreground">Checking…</p> : null}
          {status.error ? <p role="alert" className="text-destructive">{getErrorMessage(status.error, "Could not check the scheduler.")}</p> : null}
          {status.data ? (
            <>
              <p className={status.data.nextRun.at && !status.data.nextRun.dueNow ? "font-medium" : "font-medium text-amber-600"} data-testid="next-run">
                {status.data.nextRun.at ? (status.data.nextRun.dueNow ? status.data.nextRun.reason : `Next scheduled report: ${fmt(status.data.nextRun.at)} (${config.data!.sendTime} ${config.data!.timezone})`) : `No report is scheduled. ${status.data.nextRun.reason ?? ""}`}
              </p>
              <p className={status.data.scheduler.running ? "text-emerald-600" : "text-amber-600"}>
                {status.data.scheduler.running
                  ? `Scheduler running - last check ${status.data.scheduler.secondsSinceLastTick}s ago`
                  : status.data.scheduler.lastTickAt
                    ? `Scheduler NOT running - last check ${fmt(status.data.scheduler.lastTickAt)}. The server may be asleep or stopped; reports are only sent while it runs${status.data.externalCronConfigured ? "" : " (no external trigger is configured)"}.`
                    : "Scheduler has never run on this server. Reports will not be sent until it does."}
              </p>
              <p className={status.data.whatsapp.metaConfigured || status.data.whatsapp.envProviderConfigured ? "text-emerald-600" : "text-amber-600"}>
                {status.data.whatsapp.metaConfigured || status.data.whatsapp.envProviderConfigured ? "WhatsApp provider configured" : "No WhatsApp provider is configured - nothing can be sent"}
              </p>
              <p className={templates.length > 0 ? "text-emerald-600" : "text-amber-600"}>
                {templates.length > 0 ? `Report template ready: ${templates.map((t) => `${t.name} (${t.language})`).join(", ")}` : `No usable report template yet: ${status.data.requiredTemplate} (Utility, one variable named report_text) must be approved in the Meta console and synced. See the reasons below the template selector.`}
              </p>
              {status.data.scheduler.lastError ? <p className="text-xs text-destructive">Last scheduler error: {status.data.scheduler.lastError}</p> : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Automation settings</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} data-testid="automation-enabled" />
            Send the report automatically every day
          </label>
          <fieldset className="space-y-2 sm:col-span-2" data-testid="recipients">
            <legend className="text-sm font-medium">Recipients (WhatsApp number with country code, name optional)</legend>
            {form.recipients.length === 0 ? <p className="text-xs text-muted-foreground">No recipients yet.</p> : null}
            {form.recipients.map((r, i) => (
              <div key={i} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label={`Recipient ${i + 1} name`} className="w-40" value={r.name ?? ""} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="Name (optional)" />
                  <Input aria-label={`Recipient ${i + 1} number`} className="w-56" value={r.phone} onChange={(e) => setRow(i, { phone: e.target.value })} placeholder="+919876543210" aria-invalid={Boolean(rowErrors[String(i)])} />
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove recipient ${i + 1}`} onClick={() => set("recipients", form.recipients.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
                {rowErrors[String(i)] ? <p role="alert" className="text-xs text-destructive">{rowErrors[String(i)]}</p> : null}
              </div>
            ))}
            {rowErrors.list ? <p role="alert" className="text-xs text-destructive">{rowErrors.list}</p> : null}
            <Button type="button" variant="outline" size="sm" onClick={() => set("recipients", [...form.recipients, { name: "", phone: "" }])} disabled={form.recipients.length >= MAX_RECIPIENTS} data-testid="add-recipient">
              <Plus data-icon="inline-start" />
              Add recipient
            </Button>
            {form.recipients.length > 0 && Object.keys(rowErrors).length === 0 ? <p className="text-xs text-muted-foreground" data-testid="recipient-summary">The report will go to {form.recipients.length} number{form.recipients.length === 1 ? "" : "s"}: {form.recipients.map((r) => `${r.name?.trim() ? r.name.trim() + " " : ""}${normalizeRecipient(r.phone)}`).join(", ")}. Click Save settings to apply.</p> : null}
          </fieldset>
          <fieldset className="space-y-1.5 sm:col-span-2" data-testid="send-what">
            <legend className="text-sm font-medium">What to send to each recipient</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.sendText} onChange={(e) => set("sendText", e.target.checked)} />Text report (WhatsApp template message)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.sendExcel} onChange={(e) => set("sendExcel", e.target.checked)} />Excel (.xlsx) file as a second message</label>
            {form.sendExcel ? <p className="text-xs text-muted-foreground">The template notification (a short headline) always goes first. The readable full report and the Excel file are free-form WhatsApp messages, which WhatsApp delivers only within 24 hours of the recipient&apos;s last message to your business number. If they have not written recently those two are not attempted and show &ldquo;Failed&rdquo; with that reason, and you can Retry them once the recipient has messaged you. They need the Meta Cloud API.</p> : null}
            {errors.sendText ? <p role="alert" className="text-xs text-destructive">{errors.sendText}</p> : null}
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="ra-template">WhatsApp template and language (must be {REPORT_TEMPLATE_NAME})</Label>
            <NativeSelect id="ra-template" value={form.templateName ? `${form.templateName}|${form.languageCode}` : ""} onChange={(e) => { const [name = "", lang = "en"] = e.target.value.split("|"); setDraft({ ...form, templateName: name, languageCode: name ? lang : form.languageCode }); }} aria-invalid={Boolean(errors.templateName)}>
              <option value="">{templates.length === 0 ? "No usable template found" : "Select a template"}</option>
              {form.templateName && !templates.some((t) => t.name === form.templateName && t.language === form.languageCode) ? <option value={`${form.templateName}|${form.languageCode}`}>{form.templateName} ({form.languageCode}) - not found as approved, re-select</option> : null}
              {templates.map((t) => <option key={`${t.provider}:${t.name}:${t.language}`} value={`${t.name}|${t.language}`}>{templateLabel(t)}</option>)}
            </NativeSelect>
            {errors.templateName ? <p role="alert" className="text-xs text-destructive">{errors.templateName}</p> : null}
            {(status.data?.whatsapp.unusableTemplates ?? []).length > 0 ? (
              <ul className="space-y-0.5 text-xs text-amber-600" data-testid="unusable-templates">
                {status.data!.whatsapp.unusableTemplates.map((t) => <li key={`${t.provider}:${t.name}:${t.language}`}>{t.name} ({t.provider}, {t.language}, {t.status}) cannot be used: {t.reason}.</li>)}
              </ul>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ra-time">Daily send time</Label>
            <Input id="ra-time" type="time" value={form.sendTime} onChange={(e) => set("sendTime", e.target.value)} aria-invalid={Boolean(errors.sendTime)} />
            {errors.sendTime ? <p role="alert" className="text-xs text-destructive">{errors.sendTime}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ra-tz">Timezone</Label>
            <NativeSelect id="ra-tz" value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {(TIMEZONES.includes(form.timezone) ? TIMEZONES : [form.timezone, ...TIMEZONES]).map((z) => <option key={z} value={z}>{z === "Asia/Kolkata" ? "Asia/Kolkata (IST)" : z}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ra-for">Data date to report</Label>
            <NativeSelect id="ra-for" value={form.reportFor} onChange={(e) => setDraft({ ...form, reportFor: e.target.value as ReportMode, dataDate: e.target.value === "DATE" ? (form.dataDate ?? todayIn(form.timezone)) : null })}>
              {(["TODAY", "YESTERDAY", "DATE", "LAST7DAYS"] as const).map((m) => <option key={m} value={m}>{REPORT_MODE_LABEL[m]}</option>)}
            </NativeSelect>
            {form.reportFor === "DATE" ? (
              <div className="space-y-1" data-testid="data-date">
                <Input type="date" aria-label="Report data date" value={form.dataDate ?? ""} max={todayIn(form.timezone)} onChange={(e) => set("dataDate", e.target.value || null)} aria-invalid={Boolean(errors.dataDate)} />
                {errors.dataDate ? <p role="alert" className="text-xs text-destructive">{errors.dataDate}</p> : null}
                <p className="text-xs text-muted-foreground">This day&apos;s data is reported every time the report is sent, whatever day or time that is. It is saved separately from the send time.</p>
              </div>
            ) : null}
            {form.reportFor === "LAST7DAYS" ? <p className="text-xs text-muted-foreground">The seven complete days before the day it is sent (not including that day).</p> : null}
          </div>
          <fieldset className="space-y-1.5 sm:col-span-2" data-testid="roster">
            <legend className="text-sm font-medium">Telecallers in the report</legend>
            {(() => {
              const scope = preview.data?.data.scope ?? [];
              const chosen = new Set(form.includedUserIds);
              const all = chosen.size === 0;
              if (scope.length === 0) return <p className="text-xs text-muted-foreground">{preview.isLoading ? "Loading telecallers…" : "No telecallers found in your scope."}</p>;
              const toggle = (id: string, on: boolean) => {
                const next = new Set(all ? scope.map((p) => p.id) : chosen);
                if (on) next.add(id); else next.delete(id);
                set("includedUserIds", next.size === scope.length ? [] : [...next]);
              };
              return (
                <>
                  <p className="text-xs text-muted-foreground" data-testid="roster-summary">
                    {all ? `All ${scope.length} active telecallers in your scope are included, including any test or demo accounts. Untick the ones to leave out.` : `${chosen.size} of ${scope.length} telecallers included. Totals, the detailed report, the template headline and the Excel use only these; the others' figures are left out, never moved to anyone else.`}
                  </p>
                  <div className="flex flex-wrap gap-x-5 gap-y-1">
                    {scope.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={all || chosen.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
                        {p.name.trim()}
                      </label>
                    ))}
                  </div>
                </>
              );
            })()}
          </fieldset>
          <fieldset className="space-y-1.5 sm:col-span-2">
            <legend className="text-sm font-medium">Report contents</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {OPTION_LABELS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.options[k]} onChange={(e) => set("options", { ...form.options, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
            {errors.options ? <p role="alert" className="text-xs text-destructive">{errors.options}</p> : null}
          </fieldset>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="button" onClick={() => save.mutate(form)} disabled={Object.keys(errors).length > 0 || save.isPending || !dirty} data-testid="save-settings">
              {save.isPending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Report preview</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ra-date">Preview a different single day (optional)</Label>
              <Input id="ra-date" type="date" value={previewDate} onChange={(e) => setDate(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">{previewDate ? "Showing just this day." : "Showing the saved selection."} Dates are in the saved timezone: {config.data!.timezone}</p>
          </div>
          {preview.isLoading ? <p className="text-sm text-muted-foreground">Building preview…</p> : null}
          {preview.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(preview.error, "Could not build the preview.")}</p> : null}
          {preview.data ? (
            <div className="space-y-3">
              <p className="text-sm font-medium" data-testid="preview-heading">Report data: {preview.data.periodLabel} ({preview.data.timezone})</p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Telecaller</TableHead>
                      {preview.data.options.sales ? <><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Cancelled</TableHead></> : null}
                      {preview.data.options.leads ? <><TableHead className="text-right">Leads</TableHead><TableHead className="text-right">Converted</TableHead><TableHead className="text-right">Conv. %</TableHead></> : null}
                      {preview.data.options.calls ? <><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Connected</TableHead></> : null}
                      {preview.data.options.followUps ? <TableHead className="text-right">Follow-ups pending</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...(preview.data.options.teamSummary ? [{ id: "team", name: `Team (${preview.data.data.team.telecallers})`, ...preview.data.data.team }] : []), ...preview.data.data.people].map((p) => (
                      <TableRow key={p.id} className={p.id === "team" ? "font-semibold" : undefined}>
                        <TableCell>{p.name}</TableCell>
                        {preview.data!.options.sales ? <><TableCell className="text-right">{p.orders}</TableCell><TableCell className="text-right">₹{Math.round(p.revenue).toLocaleString("en-IN")}</TableCell><TableCell className="text-right">{p.cancelledOrders}</TableCell></> : null}
                        {preview.data!.options.leads ? <><TableCell className="text-right">{p.leads}</TableCell><TableCell className="text-right">{p.converted}</TableCell><TableCell className="text-right">{p.conversionPct === null ? "-" : `${p.conversionPct}%`}</TableCell></> : null}
                        {preview.data!.options.calls ? <><TableCell className="text-right">{p.calls}</TableCell><TableCell className="text-right">{p.connected}</TableCell></> : null}
                        {preview.data!.options.followUps ? <TableCell className="text-right">{p.pendingFollowUps}</TableCell> : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs" data-testid="preview-text">{preview.data.text}</pre>
              {preview.data.truncated ? <p className="text-xs text-amber-600">The WhatsApp message is shortened: not every telecaller fits in one template message.</p> : null}
              <p className="text-xs text-muted-foreground">Conversion = converted ÷ leads handed over that day. Orders follow the Sales &amp; Revenue rules (each order credited once). Only figures the CRM records are shown.</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Test send</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">Sends the report once, now, to all saved recipients through the CRM&apos;s WhatsApp sender. A test is recorded as a test and never counts as the scheduled daily report.</p>
          {!confirming ? (
            <Button type="button" variant="outline" onClick={() => { setTestResult(null); setConfirming(true); }} disabled={dirty || config.data!.recipients.length === 0 || !config.data?.templateName} data-testid="test-send">
              <Send data-icon="inline-start" />
              Send test report
            </Button>
          ) : (
            <div role="alertdialog" aria-label="Confirm test send" className="flex flex-wrap items-center gap-3 rounded-md border p-3">
              <span className="text-sm">Send a real WhatsApp message to <strong>{config.data!.recipients.map((r) => r.name || r.phone).join(", ")}</strong> now?</span>
              <Button type="button" size="sm" onClick={() => test.mutate()} disabled={test.isPending} data-testid="confirm-test-send">{test.isPending ? "Sending…" : "Yes, send"}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={test.isPending}>Cancel</Button>
            </div>
          )}
          {dirty ? <p className="text-xs text-muted-foreground">Save your changes first - the test uses the saved settings.</p> : null}
          {testResult ? <p role="status" data-testid="test-result" className={testResult.ok ? "text-sm text-emerald-600" : "text-sm text-destructive"}>{testResult.ok ? "Success: " : "Not sent: "}{testResult.text}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Delivery history</CardTitle></CardHeader>
        <CardContent>
          {history.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(history.error, "Could not load the history.")}</p> : null}
          {history.data && history.data.items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has been sent yet.</p> : null}
          {history.data && history.data.items.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Report date</TableHead><TableHead>Run</TableHead><TableHead>Scheduled for</TableHead><TableHead>Recipient</TableHead><TableHead>1. Template notification</TableHead><TableHead>2. Detailed report</TableHead><TableHead>3. Excel file</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.data.items.flatMap((d) =>
                    d.recipients.map((r) => (
                      <TableRow key={r.id} data-testid="delivery-row">
                        <TableCell>{d.reportDate}</TableCell>
                        <TableCell>{d.kind === "TEST" ? "Manual test" : "Scheduled"}</TableCell>
                        <TableCell>{fmt(d.scheduledFor)}</TableCell>
                        <TableCell>{r.name ? `${r.name} ` : ""}{r.phone}</TableCell>
                        <TableCell className="align-top"><PartCell part={r} testId="text" onRetry={() => retry.mutate({ id: r.id, part: "TEXT" })} busy={retry.isPending} /></TableCell>
                        <TableCell className="align-top"><PartCell part={r.detail} testId="detail" onRetry={() => retry.mutate({ id: r.id, part: "DETAIL" })} busy={retry.isPending} /></TableCell>
                        <TableCell className="align-top"><PartCell part={r.document} testId="excel" onRetry={() => retry.mutate({ id: r.id, part: "DOCUMENT" })} busy={retry.isPending} /></TableCell>
                      </TableRow>
                    )),
                  )}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
