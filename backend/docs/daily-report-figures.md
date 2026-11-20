# Daily WhatsApp report - where the figures come from

## Source of every number
The initial WhatsApp summary and the CRM Orders Dashboard call the SAME two services for the report's date range (Asia/Kolkata calendar day):

| Section | Service | Notes |
|---|---|---|
| Website Orders | `LiveWebsiteDashboardService` (live from Shopify) | Telecaller-created orders ("Order Created by" tag, or a CRM order from a non-storefront source) are excluded. Revenue excludes cancelled orders. COD + prepaid + other (no payment method, e.g. a zero-value order) = total orders. |
| Abandoned Checkouts | `AbandonedDashboardService` | Total = checkouts detected in the day after the canonical 60-minute duplicate rule. Converted = checkouts linked by `Order.metadata.abandonment.id` to a salesperson order in a sold status; revenue = order total minus refunds; COD + prepaid = converted. |

The report maps those outputs into the template (`report-automation.template-metrics.ts`). It never recomputes them.

## The 09:00 report is a point-in-time snapshot (intended)
The scheduled report is built at send time (09:00 IST) for the previous day and is not updated afterwards. Nothing is stored of the figures except the provider message id. Consequences:

- **Website orders** for a finished day barely move (only a later cancellation or edit in Shopify changes them).
- **Abandoned conversions keep growing.** The cohort is the checkouts DETECTED on the report day, but a telecaller can still convert them later. A conversion count read later is therefore higher than the one in the 09:00 message. Conversions never exceed detected checkouts, and the rate stays at or below 100%.
- **Order edits after the send change the figures.** A cancelled order drops out of the conversion; reverting the cancellation brings it back, and a checkout with two orders is counted once with its earliest qualifying sale.

### Worked example: 18 Nov 2026, message at 09:00 on 19 Nov (03:30:49Z)
| | At the 09:00 send | Now |
|---|---|---|
| Conversions | 32 | 43 |
| Converted revenue | ₹20,793 | ₹27,744 |

- 11 more linked orders were confirmed on 19 Nov between 10:18 and 16:33 IST: +11 conversions.
- One checkout held two orders, ₹650 (COD) and ₹549 (prepaid). The ₹650 order was cancelled at 11:07 IST on 18 Nov, so at 09:00 the checkout counted through the ₹549 order. On 19 Nov at about 12:50 IST both cancellations were reverted, and the checkout now counts through its earliest order, ₹650: +₹101.
- Check: ₹20,894 (the 32 checkouts through their earliest eligible order, as of today) − ₹650 + ₹549 = ₹20,793.

This is reconstructed from the order timestamps and the activity log. The message text itself was not stored.

## Persistent snapshots (migration `20261119000000_report_snapshots`)
The figures of the initial message are now stored. The first time a run builds them (at the 09:00 send) they are read live and written once to `report_snapshots` (one row per run, unique `delivery_id`): the ten values exactly as sent, the numbers behind them, the data date, the generation time and the template name.

- **Immutable.** A database trigger refuses every UPDATE of a snapshot, so later orders, cancellations, payment updates or checkout conversions cannot change it. The next day's report is a new run with its own snapshot.
- **Point-in-time preserved.** The figures are still read at send time, not later. A retry or a manual resend of the same run sends the STORED figures, so a message never disagrees with its own history.
- **Duplicate protection.** Concurrent creators are decided by the unique key; extra ticks, restarts and recipients add nothing. Figures that could not both be read (website and abandoned) are sent as N/A where unreadable but not frozen, so a later retry can still read them.
- **Delivery status and provider message ids** stay on the run's recipient rows, because WhatsApp reports delivery later. The snapshot history joins them (current state), while the figures never move.
- **When no snapshot exists.** A run whose recipients all had an open 24-hour window sends no template message, so nothing is generated or frozen for it. Runs created before this migration have no snapshot.
- **Where to look.** Admin or Manager: the "Report snapshots" section of the WhatsApp daily report page (API `GET /report-automation/snapshots`). Tick two reports to compare them figure by figure.

## Template: `aayushwellness_daily_team_report_2` (needs Meta approval; not submitted)
Fixes the ₹ in front of the abandoned prepaid count, and adds Other Payment Orders (website orders with no payment method, so COD + Prepaid + Other = Total). Category: Utility. Language: English. Named variables, all within Meta's 20-character limit:

    *AayushWellness CRM — Daily Team Report*
    Report Date: {{report_date}}

    *Website Orders*
    Total Orders: {{web_total_orders}}
    Total Revenue: ₹{{web_total_revenue}}
    Total COD Orders: {{web_cod_orders}}
    Total Prepaid Orders: {{web_prepaid_orders}}
    Other Payment Orders: {{web_other_orders}}

    *Abandoned Checkouts*
    Total Leads: {{aband_total_leads}}
    Orders Converted: {{aband_orders_conv}}
    Total Revenue: ₹{{aband_revenue}}
    Total COD Orders: {{aband_cod_orders}}
    Total Prepaid Orders: {{aband_prepaid_orders}}

    Reply to this message to receive the detailed report and Excel file.

Variables (11): `report_date`, `web_total_orders`, `web_total_revenue`, `web_cod_orders`, `web_prepaid_orders`, `web_other_orders`, `aband_total_leads`, `aband_orders_conv`, `aband_revenue`, `aband_cod_orders`, `aband_prepaid_orders`.

Sample values for the Meta submission form: 18 Nov 2026, 78, 48,372, 3, 74, 1, 442, 43, 27,744, 35, 8.

The CRM accepts either the ten variables (the templates already approved keep working unchanged) or these eleven, matched by name. Activation after approval: Sync templates on the report page, select `aayushwellness_daily_team_report_2`, Save. Until then the current template keeps being used.

The earlier typo in `aayushwellness_daily_team_report_1` (`₹{{aband_prepaid_orders}}`) is corrected only by this new template; an approved Meta body cannot be changed in the CRM.

## Template: `aayushwellness_daily_team_report_3` - Shopify Orders Summary (needs Meta approval; not submitted)
Replaces the Website Orders / Abandoned Checkouts summary of the first message with the complete Shopify order set. Supersedes the `_2` draft above. Category: Utility. Language: English.

Body to submit to Meta (named variables; the number in brackets is the position, i.e. {{1}} to {{5}} of the message):

    *AayushWellness CRM — Daily Team Report*
    Report Date: {{report_date}}                      [1]

    *Shopify Orders Summary*
    Total Shopify Orders: {{total_shopify_orders}}    [2]
    Website Orders: {{website_orders}}                [3]
    Telecaller-Created Orders: {{telecaller_orders}}  [4]
    Total Revenue: ₹{{total_revenue}}                 [5]

    Reply to this message to receive the detailed report and Excel file.

(Remove the bracketed position markers from the submitted body; they are only here to show the mapping.)

Why named variables and not `{{1}}`..`{{5}}`: this CRM only submits and sends named-format templates, and Meta rejects positional parameters for them (HTTP 400). The five names are mapped in the order above and are all within Meta's 20-character limit.

| Position | Variable | Meaning | 19 Nov 2026 |
|---|---|---|---|
| {{1}} | `report_date` | Report date | 19 Nov 2026 |
| {{2}} | `total_shopify_orders` | Every Shopify order of the day (website + telecaller-created) | 204 |
| {{3}} | `website_orders` | Website orders | 120 |
| {{4}} | `telecaller_orders` | Telecaller-created orders (the "Order Created by" ones, and CRM orders pushed to Shopify) | 84 |
| {{5}} | `total_revenue` | Sum of every Shopify order total, with paise, Indian grouping, no ₹ (the body has it) | 1,27,581.05 |

Sample values for the Meta submission form: 19 Nov 2026, 204, 120, 84, 1,27,581.05.

How the figures are calculated (same live Shopify read as the Orders Dashboard, IST day):
- `total_shopify_orders` = `website_orders` + `telecaller_orders`, always. Telecaller-created orders are NOT excluded.
- `total_revenue` adds EVERY order of the set at its Shopify total, **cancelled and voided orders included**, as specified. For 19 Nov that includes 2 cancelled telecaller orders (₹1,300); without them the total would be ₹1,26,281.05. This differs from the Website Orders revenue on the dashboard, which excludes cancelled orders.
- Only INR orders are added; a non-INR order is left out with a warning (none exist today). Amounts are added in whole paise.
- An unreadable Shopify section is sent as `N/A` in all four figures, never as zero, and is not frozen.

Snapshots: a run using this template freezes the report date and the four figures (and the website / abandoned figures read at the same time) at generation. A retry, manual resend or reply uses the stored figures and never reads Shopify again; history cannot change. The run history shows the Shopify figures; older snapshots show "-" for them.

Compatibility: the CRM accepts this five-variable template, the original ten-variable one and the eleven-variable `_2` draft, matched by name. Until `_3` is approved, synced and selected, the currently selected template keeps being used unchanged. Activation: Sync templates, select `aayushwellness_daily_team_report_3`, Save.

## Connecting `aayushwellness_daily_team_report_3` in the CRM
Where it lives: **WhatsApp daily report -> Schedule settings -> "Initial message template"** (above the template dropdown). It is a read-only status card; nothing is selected or saved until an admin presses **Use this template** and then **Save settings**.

What the CRM now knows about the template (`report-automation.summary-template.ts`, served by `GET /report-automation/status` as `summaryTemplate` and `selectedTemplate`):
- the template name and its five-variable mapping, `{{1}}`..`{{5}}` = `report_date`, `total_shopify_orders`, `website_orders`, `telecaller_orders`, `total_revenue`;
- its state among the templates synced from Meta:

| State | Meaning | What the admin sees |
|---|---|---|
| Not added yet | Not in the CRM | "Submit it in Meta... then press Sync templates or use Add template" + a Check Meta (Sync templates) button |
| Waiting for Meta approval / Rejected by Meta / Disabled at Meta / Draft | In the CRM, status is not APPROVED | The Meta status and what to do; cannot be selected |
| Variables don't match | Approved, but not exactly the five names | The variables it has and the five it needs |
| Approved - ready | Approved with exactly the five variables | **Use this template** (sets it, with its language, in the form) |

- what the template saved today sends (Shopify Orders Summary / Website + Abandoned summary / one-line text), and a red warning, also in the page's top health strip, if the SAVED selection cannot be sent (for example `_3` selected before Meta approved it), so a scheduled report cannot fail silently.

The summary is built from the five variables by name and the figures are frozen in the run's snapshot (see above). The detailed report, the Excel and the reply trigger are unchanged: a reply still releases the detailed text and the Excel once, and the summary is not re-sent.

When a send is attempted with a template that is not approved, the run records the exact reason ("not in the CRM yet", or "in the CRM with status PENDING: it cannot be sent until Meta approves it and Sync templates has been pressed") and nothing is sent.

Activation once Meta approves it: Sync templates (or Add template), the card turns green, Use this template, Save settings. Until then the template selected today keeps being used unchanged. No database row for the template is created by the CRM; it only ever arrives from Meta.
