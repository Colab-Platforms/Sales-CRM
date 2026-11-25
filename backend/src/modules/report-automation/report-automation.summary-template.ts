import { classifyReportTemplates, evaluateReportTemplate, isReportTemplateName, variableNames } from "./report-automation.sender.js";
import { isShopifySummarySet, isStructuredVariableSet, SHOPIFY_SUMMARY_VARIABLES, type ShopifySummaryVariable } from "./report-automation.template-metrics.js";

// CONFIGURATION of the initial Daily Team Report message: which Meta template it is meant to use and what each of its five variables stands for, plus a plain-language STATE of that template in this CRM.
// Read-only: nothing here sends, saves or selects anything. The template row itself reaches the CRM only through Meta (Sync templates / Add template); which template the automation actually uses is
// still the saved setting, so until this one is approved, synced AND selected, whatever is selected now keeps being used unchanged.

/** The template the initial message is meant to use: the "Shopify Orders Summary". */
export const SUMMARY_TEMPLATE_NAME = "aayushwellness_daily_team_report_3";

const MEANING: Record<ShopifySummaryVariable, string> = {
  report_date: "Report date",
  total_shopify_orders: "Total Shopify orders (website + telecaller-created)",
  website_orders: "Website orders",
  telecaller_orders: "Successful telecaller-created orders (not cancelled, returned or refunded)",
  total_revenue: "Shopify revenue, excluding cancelled, returned and refunded orders (with paise)",
};

/** {{1}}..{{5}} of the message in order, with the named variable each position is filled through. */
export const SUMMARY_TEMPLATE_MAPPING: { position: number; variable: ShopifySummaryVariable; meaning: string }[] = SHOPIFY_SUMMARY_VARIABLES.map((variable, i) => ({ position: i + 1, variable, meaning: MEANING[variable] }));

export type SummaryTemplateState = "NOT_ADDED" | "NOT_APPROVED" | "VARIABLES_MISMATCH" | "READY";

export interface SummaryTemplateStatus {
  name: string;
  state: SummaryTemplateState;
  /** Meta's status of the template as synced (APPROVED / PENDING / REJECTED / DISABLED / DRAFT), null when it is not in the CRM. */
  status: string | null;
  language: string | null;
  provider: string | null;
  /** What this means and what to do, in plain words. */
  reason: string;
  /** Is it the template the saved automation currently uses? */
  selected: boolean;
  mapping: typeof SUMMARY_TEMPLATE_MAPPING;
}

interface StoredTemplate { name: string; provider: string; language: string; status: string; variables: unknown }

const NOT_APPROVED_REASON: Record<string, string> = {
  PENDING: "Submitted to Meta and waiting for approval.",
  REJECTED: "Rejected by Meta. Correct it in Meta and submit it again, then press Sync templates.",
  DISABLED: "Disabled (paused or disabled at Meta), so it cannot be sent. Re-enable it in Meta, then press Sync templates.",
  DRAFT: "Saved in the CRM as a draft only: it has not been approved by Meta, so it cannot be sent.",
};
/** What it means for the report: if another template is selected, that one keeps being used; if THIS one is selected, scheduled reports cannot be sent until it is available. */
const consequence = (selected: boolean): string =>
  selected ? " It is the template selected for the report, so scheduled reports cannot be sent until it is approved and synced - select another template meanwhile." : " Nothing changes until it is approved, synced and selected; the template selected now keeps being used.";

/**
 * Is this the Shopify Orders Summary template? The name is aayushwellness_daily_team_report_3 - or that name with a suffix: Meta never lets a deleted template name be reused, so the approved one may be
 * registered as e.g. aayushwellness_daily_team_report_3_3. Any other report-family template that declares exactly the five variables is also the summary template, whatever it is called.
 */
const SUMMARY_FAMILY = /^aayushwellness_daily_team_report_3(?:_[A-Za-z0-9_]+)?$/;
export const isSummaryTemplateName = (name: string): boolean => SUMMARY_FAMILY.test(name);
const isSummaryCandidate = (t: StoredTemplate): boolean => isSummaryTemplateName(t.name) || (isReportTemplateName(t.name) && isShopifySummarySet(variableNames(t.variables)));
const isReady = (t: StoredTemplate): boolean => t.status === "APPROVED" && isShopifySummarySet(variableNames(t.variables)) && evaluateReportTemplate(t).ok;

/** The state of the Shopify Orders Summary template among the CRM's synced templates. Pure. */
export function summaryTemplateStatus(templates: readonly StoredTemplate[], selected: { name: string | null; language?: string | null } | null): SummaryTemplateStatus {
  // The best candidate: a usable one first, then an approved one with the wrong variables, then any other; the selected one, Meta, and the saved language break ties.
  const rank = (t: StoredTemplate) => (isReady(t) ? 0 : t.status === "APPROVED" ? 1 : 2);
  const rows = templates
    .filter(isSummaryCandidate)
    .sort((x, y) => rank(x) - rank(y) || Number(y.name === selected?.name) - Number(x.name === selected?.name) || Number(y.provider === "META") - Number(x.provider === "META") || Number(y.language === selected?.language) - Number(x.language === selected?.language));
  const pick = (t: StoredTemplate) => ({ name: t.name, status: t.status, language: t.language, provider: t.provider });
  const isSelected = (name: string) => selected?.name === name;
  const mapping = SUMMARY_TEMPLATE_MAPPING;

  if (rows.length === 0) {
    return { name: SUMMARY_TEMPLATE_NAME, selected: isSelected(SUMMARY_TEMPLATE_NAME), mapping, state: "NOT_ADDED", status: null, language: null, provider: null, reason: `"${SUMMARY_TEMPLATE_NAME}" is not in the CRM yet. Submit it in Meta (Utility, English, the five variables below; Meta may add a suffix such as _3_3 to the name, which is recognised); once Meta approves it, press Sync templates or use Add template.` };
  }
  const best = rows[0]!;
  const common = { ...pick(best), selected: isSelected(best.name), mapping };
  if (isReady(best)) {
    return { ...common, state: "READY", reason: common.selected ? "Approved and selected: the first message is the Shopify Orders Summary." : "Approved by Meta and ready. Select it and Save to send the Shopify Orders Summary as the first message." };
  }
  if (best.status === "APPROVED") {
    const names = variableNames(best.variables);
    const reason = evaluateReportTemplate(best);
    return { ...common, state: "VARIABLES_MISMATCH", reason: !reason.ok ? reason.reason : `Approved, but its variables (${names.join(", ") || "none"}) are not the five this report fills (${SHOPIFY_SUMMARY_VARIABLES.join(", ")}). Create it in Meta with exactly these variable names.` };
  }
  const why = NOT_APPROVED_REASON[best.status] ?? `Its Meta status is ${best.status}, not APPROVED, so it cannot be sent yet.`;
  return { ...common, state: "NOT_APPROVED", reason: `${why}${consequence(common.selected)}` };
}

/** What the template the automation uses TODAY sends, by the variables it declares. */
export type SummaryKind = "SHOPIFY_SUMMARY" | "WEBSITE_ABANDONED" | "REPORT_TEXT" | "UNKNOWN";

export interface SelectedTemplateStatus {
  name: string;
  language: string | null;
  /** Can the sender use it right now? A saved selection that is not approved or not found would make a scheduled report fail - say so before it happens. */
  usable: boolean;
  reason: string | null;
  sends: SummaryKind;
}

export const SUMMARY_KIND_LABEL: Record<SummaryKind, string> = {
  SHOPIFY_SUMMARY: "Shopify Orders Summary (total, website, telecaller-created, revenue)",
  WEBSITE_ABANDONED: "Website Orders + Abandoned Checkouts summary",
  REPORT_TEXT: "One-line report text",
  UNKNOWN: "Unknown",
};

/** The saved selection: is it usable now, and which summary does it send? null = nothing selected. Pure. */
export function selectedTemplateStatus(templates: readonly StoredTemplate[], selected: { name: string | null; language: string | null } | null): SelectedTemplateStatus | null {
  if (!selected?.name) return null;
  const { usable, unusable } = classifyReportTemplates([...templates]);
  const sameLang = (t: { language: string }) => !selected.language || t.language === selected.language;
  const usableRow = usable.find((t) => t.name === selected.name && sameLang(t));
  const row = templates.find((t) => t.name === selected.name && sameLang(t)) ?? templates.find((t) => t.name === selected.name);
  const names = row ? variableNames(row.variables) : [];
  const sends: SummaryKind = isShopifySummarySet(names) ? "SHOPIFY_SUMMARY" : isStructuredVariableSet(names) ? "WEBSITE_ABANDONED" : names.length === 1 ? "REPORT_TEXT" : "UNKNOWN";
  if (usableRow) return { name: selected.name, language: usableRow.language, usable: true, reason: null, sends };
  const why = unusable.find((t) => t.name === selected.name && sameLang(t)) ?? unusable.find((t) => t.name === selected.name);
  const reason = why ? `${why.reason}` : row ? `Its status is ${row.status}.` : `"${selected.name}" is not in the CRM as an approved template.`;
  return { name: selected.name, language: selected.language, usable: false, reason, sends };
}
