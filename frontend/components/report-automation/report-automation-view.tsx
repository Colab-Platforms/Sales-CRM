"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { reportAutomationApi } from "@/lib/api-client/endpoints/report-automation.api";
import { whatsappTemplatesApi } from "@/lib/api-client/endpoints/whatsapp-templates.api";
import type { ReportAutomationConfigInput, ReportMessagePart, ReportMode, ReportOptions } from "@/lib/api-client/types/report-automation.types";
import { cancelConfirmText, cancelFailureText, cancelSuccessText, configToInput, formatInZone, isDirty, normalizeRecipient, PAUSE_CONFIRM, REPORT_TEMPLATE_NAME, SYNC_TIMEOUT_MS, syncFailureMessage, syncMessage, TIMEZONES, validateForm, validateRecipients } from "./report-automation-form";
import { explainNext, nextOccurrence, PHASE_LABEL, PHASE_TONE, rangeText, runPhase, type DataRange } from "./report-automation-schedule";
import { RecipientManager } from "./report-recipients";
import { ReportHistory } from "./report-history";
import { ReportLiveTracking } from "./report-live-tracking";
import { ReportPreviewPanel } from "./report-preview-panel";
import { ReportTemplatePicker } from "./report-template-picker";

const keys = { config: ["report-automation", "config"] as const, status: ["report-automation", "status"] as const };

const OPTION_LABELS: [keyof ReportOptions, string][] = [
  ["teamSummary", "Team summary"],
  ["sales", "Orders, revenue and cancelled orders"],
  ["leads", "Leads handled and conversion"],
  ["calls", "Calls and talk time"],
  ["followUps", "Pending follow-ups"],
];
// The recurring report is always relative to the day it is sent. A fixed date is not offered: it would keep reporting one old day.
const PERIOD_OPTIONS: [ReportMode, string][] = [["YESTERDAY", "Previous day (recommended)"], ["TODAY", "Same day it is sent"], ["LAST7DAYS", "Previous 7 days"]];

/** "daily_team_report1 - META - en - APPROVED": everything that identifies the template the report will really use. */
export const templateLabel = (t: { name: string; provider: string; language: string; status: string }): string => `${t.name} - ${t.provider} - ${t.language} - ${t.status}`;

function Switch({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} data-testid={testId} className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50", checked ? "bg-emerald-600" : "bg-muted-foreground/30")}>
      <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function Stat({ label, value, sub, tone, testId }: { label: string; value: string; sub?: string; tone?: string; testId?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2.5" data-testid={testId}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 truncate text-sm font-semibold", tone)}>{value}</p>
      {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

const FORMAT_WORD: Record<string, string> = { NOTIFICATION: "WhatsApp summary", DETAIL: "Detailed report", EXCEL: "Excel" };

export function ReportAutomationView() {
  const role = useAuthStore((s) => s.user?.role);
  const queryClient = useQueryClient();
  const allowed = role === "ADMIN" || role === "MANAGER";

  const config = useQuery({ queryKey: keys.config, queryFn: reportAutomationApi.getConfig, enabled: allowed });
  const scheduled = useQuery({ queryKey: ["report-automation", "scheduled", config.data?.updatedAt], queryFn: reportAutomationApi.scheduled, enabled: allowed, refetchInterval: 30_000 });
  const status = useQuery({ queryKey: keys.status, queryFn: reportAutomationApi.status, enabled: allowed, refetchInterval: 60_000 });

  // The form is the saved settings until something is edited (a draft); saving clears the draft so the form shows what the server stored.
  const [draft, setDraft] = useState<ReportAutomationConfigInput | null>(null);
  const c = config.data;
  const saved = useMemo(() => (c ? configToInput(c) : null), [c]);
  const form = draft ?? saved;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  // The preview (and the telecaller list that shares its data) is only requested once one of those sections is opened.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [date, setDate] = useState("");
  const preview = useQuery({ queryKey: ["report-automation", "preview", date, config.data?.updatedAt], queryFn: () => reportAutomationApi.preview(date || undefined), enabled: allowed && Boolean(config.data) && (previewOpen || rosterOpen) });

  const refreshAll = () => void queryClient.invalidateQueries({ queryKey: ["report-automation"] });
  const save = useMutation({
    mutationFn: (input: ReportAutomationConfigInput) => reportAutomationApi.saveConfig({ ...input, recipients: input.recipients.map((r) => ({ ...(r.name?.trim() ? { name: r.name.trim() } : {}), phone: normalizeRecipient(r.phone), enabled: r.enabled !== false })) }),
    onSuccess: (s) => { toast.success("Settings saved"); queryClient.setQueryData(keys.config, s); setDraft(null); refreshAll(); },
    onError: (e) => toast.error(getErrorMessage(e, "Could not save the settings.")),
  });
  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => reportAutomationApi.setEnabled(enabled),
    onSuccess: (_d, enabled) => { toast.success(enabled ? "Automation is active." : "Automation paused. Nothing further will be sent on a schedule."); setDraft((d) => (d ? { ...d, enabled } : null)); refreshAll(); },
    onError: (e) => toast.error(getErrorMessage(e)),
  });
  const cancelRun = useMutation({
    mutationFn: (occurrenceDate: string) => reportAutomationApi.cancelScheduled(occurrenceDate),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["report-automation"] }); },
    onError: async (e) => { toast.error(cancelFailureText(e)); await queryClient.invalidateQueries({ queryKey: ["report-automation"] }); },
  });
  const removeRun = useMutation({
    mutationFn: (runId: string) => reportAutomationApi.deleteRun(runId),
    onSuccess: () => { toast.success("Removed from history. Messages already sent are not recalled."); refreshAll(); },
    onError: (e) => { toast.error(getErrorMessage(e)); refreshAll(); },
  });

  // Templates: sync from Meta (Admin) or pick one of Meta's approved templates.
  const [syncResult, setSyncResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const sync = useMutation({
    mutationFn: () => whatsappTemplatesApi.sync("META", SYNC_TIMEOUT_MS),
    retry: false,
    onMutate: () => setSyncResult(null),
    onSuccess: (s) => setSyncResult(syncMessage(s)),
    onError: (e) => setSyncResult({ ok: false, text: syncFailureMessage(e) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.status }),
  });

  // Test send: a real message to the saved recipients, recorded as a test.
  const [confirming, setConfirming] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => reportAutomationApi.testSend(),
    onSuccess: (d) => {
      const ok = (p: ReportMessagePart) => p.status === "SENT" || p.status === "DELIVERED" || p.status === "READ";
      const total = d.recipients.length;
      const kinds: [string, (r: (typeof d.recipients)[number]) => ReportMessagePart][] = [["WhatsApp summary", (r) => r], ["Detailed report", (r) => r.detail], ["Excel", (r) => r.document]];
      const active = kinds.filter(([, get]) => d.recipients.some((r) => get(r).status !== "SKIPPED"));
      const counts = active.map(([label, get]) => ({ label, n: d.recipients.filter((r) => ok(get(r))).length }));
      const reasons = [...new Set(d.recipients.flatMap((r) => [r.error, r.detail.error, r.document.error]).filter((x): x is string => Boolean(x)))];
      setTestResult({ ok: counts.every((x) => x.n === total), text: `${counts.map((x) => `${x.label}: ${x.n} of ${total} accepted`).join(" | ")}.${reasons.length > 0 ? ` Reason: ${reasons.join(" / ")}` : ""}` });
      refreshAll();
    },
    onError: (e) => setTestResult({ ok: false, text: getErrorMessage(e, "The test could not be sent.") }),
    onSettled: () => setConfirming(false),
  });

  if (!allowed) {
    return <div role="alert" className="py-10 text-center text-sm text-muted-foreground" data-testid="report-automation-forbidden">This section is available to Admin and Manager users only.</div>;
  }
  if (config.error) return <p role="alert" className="py-10 text-sm text-destructive">{getErrorMessage(config.error, "Failed to load the settings.")}</p>;
  if (config.isLoading || !form || !c) return <p className="py-10 text-sm text-muted-foreground">Loading…</p>;

  const errors = validateForm(form);
  const rowErrors = validateRecipients(form.recipients, form.enabled);
  const set = <K extends keyof ReportAutomationConfigInput>(k: K, v: ReportAutomationConfigInput[K]) => setDraft({ ...form, [k]: v });
  const dirty = isDirty(form, c);
  const templates = status.data?.whatsapp.templates ?? [];
  const tz = form.timezone;
  const savedTz = c.timezone;

  // ---- A. overview (always the SAVED settings: that is what the scheduler uses) and C. the next report
  const upcoming = scheduled.data?.upcoming ?? [];
  const nextDate = upcoming[0]?.occurrenceDate;
  const nextRows = nextDate ? upcoming.filter((u) => u.occurrenceDate === nextDate) : [];
  const nextSaved = nextRows[0] ? { sendAt: new Date(nextRows[0].scheduledAt), sendDate: nextRows[0].occurrenceDate ?? "", data: { from: nextRows[0].dataFrom, to: nextRows[0].dataTo } as DataRange } : null;
  const activeRecipients = c.recipients.filter((r) => r.enabled);
  const last = status.data?.lastScheduled ?? null;
  const lastPhase = last ? runPhase(last) : null;

  // The preview of what the form WOULD do once saved - recalculated from the edited time, period, timezone and recipients.
  const nextDraft = dirty ? nextOccurrence(form, now) : null;
  const draftActive = form.recipients.filter((r) => r.enabled !== false);
  const draftFormats = [form.sendText ? "WhatsApp summary" : null, form.sendText && form.replyTriggersDetail ? "Detailed report on reply" : null, form.sendExcel ? "Excel" : null].filter(Boolean).join(" + ");
  const savedFormats = nextRows[0] ? nextRows[0].formats.map((f) => FORMAT_WORD[f]).join(" + ") : "";

  const health: string[] = [];
  if (status.data) {
    if (!status.data.scheduler.running) health.push(status.data.scheduler.lastTickAt ? `The scheduler has not checked in since ${formatInZone(status.data.scheduler.lastTickAt, savedTz)}. The server may be asleep; reports are only sent while it runs.` : "The scheduler has never run on this server.");
    if (!status.data.whatsapp.metaConfigured && !status.data.whatsapp.envProviderConfigured) health.push("No WhatsApp provider is configured, so nothing can be sent.");
    if (templates.length === 0) health.push(`No usable report template yet: ${status.data.requiredTemplate} must be approved in Meta and synced.`);
    if (status.data.scheduler.lastError) health.push(`Last scheduler error: ${status.data.scheduler.lastError}`);
  }

  const removable = new Map<string, { canDelete: boolean; reason: string | null }>();
  for (const r of scheduled.data?.recent ?? []) if (r.runId && !removable.has(r.runId)) removable.set(r.runId, { canDelete: Boolean(r.canDelete), reason: r.deleteBlockedReason ?? null });

  const showDraftNext = dirty && form.enabled && nextDraft && draftActive.length > 0 && Object.keys(errors).length === 0;
  const shown = showDraftNext && nextDraft ? { sendAt: nextDraft.sendAt, sendDate: nextDraft.sendDate, data: nextDraft.data } : form.enabled === c.enabled ? nextSaved : null;
  const shownTz = showDraftNext ? tz : savedTz;
  const shownRecipients = showDraftNext ? draftActive.map((r) => r.name?.trim() || "Unnamed") : nextRows.map((r) => r.recipientName || r.recipientPhone);

  const pauseOrResume = (on: boolean) => {
    if (!c.id) { set("enabled", on); return; } // never saved: it is part of the first save
    if (!on && !window.confirm(PAUSE_CONFIRM)) return;
    toggleEnabled.mutate(on);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="WhatsApp daily report" description="A daily team performance report sent to WhatsApp. Admin: all telecallers. Manager: your team." />

      {/* A. Overview */}
      <section className="space-y-2" aria-label="Overview">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5" data-testid="overview">
          <Stat testId="stat-automation" label="Automation" value={!c.id ? "Not set up" : c.enabled ? "Active" : "Paused"} tone={c.enabled ? "text-emerald-600" : "text-amber-600"} sub={c.enabled ? "Sends every day" : c.id ? "Nothing is scheduled" : undefined} />
          <Stat testId="stat-next" label="Next send" value={nextSaved && c.enabled ? `${formatInZone(nextSaved.sendAt.toISOString(), savedTz).replace(/ IST$/, "")}` : "—"} sub={nextSaved && c.enabled ? savedTz : undefined} />
          <Stat testId="stat-covers" label="Report covers" value={nextSaved && c.enabled ? rangeText(nextSaved.data) : "—"} sub={nextSaved && c.enabled ? "Data date" : undefined} />
          <Stat testId="stat-recipients" label="Recipients" value={String(activeRecipients.length)} sub={c.recipients.length !== activeRecipients.length ? `${c.recipients.length - activeRecipients.length} disabled` : "active"} />
          <Stat testId="stat-last" label="Last delivery" value={lastPhase ? PHASE_LABEL[lastPhase] : "None yet"} tone={lastPhase === "SENT" ? "text-emerald-600" : lastPhase === "FAILED" ? "text-destructive" : undefined} sub={last ? `Data ${rangeText({ from: last.reportFrom, to: last.reportDate })}` : undefined} />
        </div>
        {health.length > 0 ? (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="health">
            {health.map((h) => <p key={h}>{h}</p>)}
          </div>
        ) : null}
        {dirty ? <p role="alert" className="text-xs font-medium text-amber-600" data-testid="unsaved-warning">You have unsaved changes. The cards above show what is saved; the Next report section previews your edits. Nothing changes until you click Save settings.</p> : null}
      </section>

      {/* Live delivery tracking of one report run */}
      <ReportLiveTracking timezone={savedTz} />

      {/* C. Next report */}
      <Card data-testid="next-report">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle>Next report{showDraftNext ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase text-amber-800">Preview of unsaved changes</span> : null}</CardTitle>
          {!showDraftNext && shown && c.enabled && role === "ADMIN" && shown.sendDate ? (
            <Button type="button" size="sm" variant="outline" disabled={cancelRun.isPending || scheduled.isFetching} data-testid="cancel-occurrence" onClick={() => {
              const row = nextRows[0];
              if (row && window.confirm(cancelConfirmText(row))) cancelRun.mutate(shown.sendDate, { onSuccess: () => toast.success(cancelSuccessText(row)) });
            }}>Skip this report</Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {scheduled.isLoading && !showDraftNext ? <p className="text-muted-foreground">Loading…</p> : null}
          {!shown && !scheduled.isLoading ? (
            <p className="text-muted-foreground" data-testid="scheduled-none">{!c.enabled ? "Automation is paused - no report will be sent until you turn it on." : scheduled.data?.reason ?? "Nothing is scheduled."}</p>
          ) : null}
          {shown ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs text-muted-foreground">Scheduled send</dt><dd className="font-medium" data-testid="next-send">{formatInZone(shown.sendAt.toISOString(), shownTz)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Report data date</dt><dd className="font-medium" data-testid="next-data-date">{rangeText(shown.data, true)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Recipients</dt><dd className="font-medium" title={shownRecipients.join(", ")}>{shownRecipients.length} selected</dd></div>
                <div><dt className="text-xs text-muted-foreground">Delivery</dt><dd className="font-medium">{(showDraftNext ? draftFormats : savedFormats) || "-"}</dd></div>
              </dl>
              <p className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="next-explanation">{explainNext(shown, shownTz, now)}</p>
              <p className="text-xs text-muted-foreground">Status: <span className={cn("rounded-full px-2 py-0.5 font-medium", showDraftNext ? "bg-amber-100 text-amber-800" : PHASE_TONE.SCHEDULED)}>{showDraftNext ? "Not saved yet" : PHASE_LABEL.SCHEDULED}</span>{shownRecipients.length > 0 ? ` · ${shownRecipients.join(", ")}` : ""}</p>
            </>
          ) : null}
          {scheduled.data && scheduled.data.cancelledUpcoming.length > 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="cancelled-upcoming">Skipped: {scheduled.data.cancelledUpcoming.map((x) => `${formatInZone(x.scheduledAt, x.timezone)}${x.cancelledBy ? ` (by ${x.cancelledBy})` : ""}`).join("; ")}.</p>
          ) : null}
        </CardContent>
      </Card>

      {/* B. Schedule configuration */}
      <Card>
        <CardHeader className="pb-2"><CardTitle>Schedule settings</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">Automation</p>
              <p className="text-xs text-muted-foreground" data-testid="saved-state">{form.enabled ? "On - sends every day at the time below." : "Off - nothing is sent on a schedule."}</p>
            </div>
            <Switch checked={form.enabled} onChange={pauseOrResume} disabled={toggleEnabled.isPending} label="Automation on or off" testId="automation-enabled" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              <Label>Frequency</Label>
              <p className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">Daily</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ra-for">Report covers</Label>
              <NativeSelect id="ra-for" value={form.reportFor} onChange={(e) => setDraft({ ...form, reportFor: e.target.value as ReportMode, dataDate: null })}>
                {PERIOD_OPTIONS.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
              </NativeSelect>
            </div>
          </div>
          {c.reportFor === "DATE" ? <p className="text-xs text-amber-600" data-testid="legacy-date-note">A fixed report date was saved earlier. A daily report should follow the send date, so it is shown here as Previous day - click Save settings to apply that.</p> : null}

          <div className="space-y-1.5">
            <Label htmlFor="ra-template">WhatsApp template</Label>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect wrapperClassName="max-w-md flex-1" id="ra-template" value={form.templateName ? `${form.templateName}|${form.languageCode}` : ""} onChange={(e) => { const [name = "", lang = "en"] = e.target.value.split("|"); setDraft({ ...form, templateName: name, languageCode: name ? lang : form.languageCode }); }} aria-invalid={Boolean(errors.templateName)}>
                <option value="">{templates.length === 0 ? "No usable template found" : "Select a template"}</option>
                {form.templateName && !templates.some((t) => t.name === form.templateName && t.language === form.languageCode) ? <option value={`${form.templateName}|${form.languageCode}`}>{form.templateName} ({form.languageCode}) - not found as approved, re-select</option> : null}
                {templates.map((t) => <option key={`${t.provider}:${t.name}:${t.language}`} value={`${t.name}|${t.language}`}>{templateLabel(t)}</option>)}
              </NativeSelect>
              {role === "ADMIN" ? (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending} data-testid="sync-templates">{sync.isPending ? "Syncing…" : "Sync"}</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setPicking(true)} data-testid="add-template">Add template</Button>
                </>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">Must be the approved {REPORT_TEMPLATE_NAME} template.{role !== "ADMIN" ? " Only an Admin can sync or add templates." : ""}</p>
            {syncResult ? <p role={syncResult.ok ? "status" : "alert"} className={`text-xs ${syncResult.ok ? "text-emerald-600" : "text-destructive"}`} data-testid="sync-result">{syncResult.text}</p> : null}
            {errors.templateName ? <p role="alert" className="text-xs text-destructive">{errors.templateName}</p> : null}
            {(status.data?.whatsapp.unusableTemplates ?? []).length > 0 ? (
              <details className="text-xs text-amber-700">
                <summary className="cursor-pointer">{status.data!.whatsapp.unusableTemplates.length} template(s) cannot be used</summary>
                <ul className="mt-1 space-y-0.5" data-testid="unusable-templates">{status.data!.whatsapp.unusableTemplates.map((t) => <li key={`${t.provider}:${t.name}:${t.language}`}>{t.name} ({t.language}, {t.status}): {t.reason}.</li>)}</ul>
              </details>
            ) : null}
          </div>

          <RecipientManager rows={form.recipients} onChange={(next) => set("recipients", next)} listError={rowErrors.list} />

          <div className="grid gap-3 sm:grid-cols-2" data-testid="send-what">
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
              <p className="text-sm">WhatsApp summary message</p>
              <Switch checked={form.sendText} onChange={(v) => set("sendText", v)} label="WhatsApp summary message" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
              <p className="text-sm">Excel attachment</p>
              <Switch checked={form.sendExcel} onChange={(v) => set("sendExcel", v)} label="Excel attachment" testId="excel-switch" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 sm:col-span-2" data-testid="reply-triggers-detail">
              <div>
                <p className="text-sm font-medium">Reply-triggered detailed report</p>
                <p className="text-xs text-muted-foreground">Reply to Daily Report → Send Detailed Report + Excel to All Recipients</p>
              </div>
              <Switch checked={form.replyTriggersDetail} onChange={(v) => set("replyTriggersDetail", v)} label="Reply-triggered detailed report" testId="reply-switch" />
            </div>
          </div>
          {errors.sendText ? <p role="alert" className="text-xs text-destructive">{errors.sendText}</p> : null}
          {form.sendExcel || form.replyTriggersDetail ? <p className="text-xs text-muted-foreground">WhatsApp delivers the detailed report and Excel only to people who messaged the business number in the last 24 hours; for anyone else it is sent as soon as they reply.</p> : null}

          <details className="rounded-md border px-3 py-2" onToggle={(e) => setRosterOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="roster">
            <summary className="cursor-pointer text-sm font-medium">Telecallers in the report <span className="font-normal text-muted-foreground">({form.includedUserIds.length === 0 ? "all" : `${form.includedUserIds.length} selected`})</span></summary>
            <div className="mt-2 space-y-2">
              {(() => {
                const scope = preview.data?.data.scope ?? [];
                const chosen = new Set(form.includedUserIds);
                const all = chosen.size === 0;
                if (scope.length === 0) return <p className="text-xs text-muted-foreground">{preview.isLoading ? "Loading telecallers…" : "No telecallers found in your scope."}</p>;
                const toggle = (id: string) => {
                  const next = new Set(all ? scope.map((p) => p.id) : chosen);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  set("includedUserIds", next.size === scope.length ? [] : [...next]);
                };
                return (
                  <>
                    <p className="text-xs text-muted-foreground" data-testid="roster-summary">{all ? `All ${scope.length} active telecallers are included. Click a name to leave it out.` : `${chosen.size} of ${scope.length} included. The others' figures are left out of every total, never moved to someone else.`}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {scope.map((p) => {
                        const on = all || chosen.has(p.id);
                        return <button key={p.id} type="button" aria-pressed={on} onClick={() => toggle(p.id)} className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors", on ? "border-primary/40 bg-primary/10 font-medium" : "text-muted-foreground line-through")}>{p.name.trim()}</button>;
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          </details>

          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Report contents</summary>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
              {OPTION_LABELS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.options[k]} onChange={(e) => set("options", { ...form.options, [k]: e.target.checked })} />{label}</label>
              ))}
            </div>
            {errors.options ? <p role="alert" className="mt-1 text-xs text-destructive">{errors.options}</p> : null}
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => save.mutate(form)} disabled={Object.keys(errors).length > 0 || save.isPending || !dirty} data-testid="save-settings">{save.isPending ? "Saving…" : "Save settings"}</Button>
            {!confirming ? (
              <Button type="button" variant="outline" onClick={() => { setTestResult(null); setConfirming(true); }} disabled={dirty || activeRecipients.length === 0 || !c.templateName} title={dirty ? "Save your changes first - the test uses the saved settings" : undefined} data-testid="test-send"><Send data-icon="inline-start" />Send test report</Button>
            ) : (
              <span role="alertdialog" aria-label="Confirm test send" className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                Send a real WhatsApp message to <strong>{activeRecipients.map((r) => r.name || "Unnamed").join(", ")}</strong> now?
                <Button type="button" size="sm" onClick={() => test.mutate()} disabled={test.isPending} data-testid="confirm-test-send">{test.isPending ? "Sending…" : "Yes, send"}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={test.isPending}>Cancel</Button>
              </span>
            )}
            {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          </div>
          {testResult ? <p role="status" data-testid="test-result" className={testResult.ok ? "text-sm text-emerald-600" : "text-sm text-destructive"}>{testResult.ok ? "Success: " : "Not sent: "}{testResult.text}</p> : null}
        </CardContent>
      </Card>

      {/* D. Report history */}
      <Card>
        <CardHeader className="pb-2"><CardTitle>Report history</CardTitle></CardHeader>
        <CardContent>
          <ReportHistory timezone={savedTz} removable={removable} onRemove={(id) => { if (window.confirm("Remove this run from the history? It only hides the entry - messages already sent are not recalled.")) removeRun.mutate(id); }} removing={removeRun.isPending} />
        </CardContent>
      </Card>

      <ReportPreviewPanel preview={preview} onOpenChange={setPreviewOpen} date={date} onDateChange={setDate} timezone={savedTz} nextCovers={nextSaved && c.enabled ? rangeText(nextSaved.data, true) : null} />

      {picking && role === "ADMIN" ? <ReportTemplatePicker onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
