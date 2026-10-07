"use client";

import type { ReactNode } from "react";
import { ORDER_SOURCE_LABELS, ORDER_SOURCE_ORDER, ORDER_STATUS_LABELS, ORDER_STATUS_ORDER, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_ORDER } from "@/lib/order-status";
import type { PaymentStatusFilter } from "@/lib/api-client/types/orders.types";
import { OrdersTagsFilter, type TagOption } from "./orders-tags-filter";
import { CheckList, ColumnFilter, RadioList, RangeInputs, type Option } from "./column-filter";
import {
  DATE_PRESETS,
  DATE_PRESET_LABELS,
  FULFILLMENT_VALUES,
  TOTAL_PRESETS,
  activeTotalPreset,
  isColumnActive,
  type ColumnFilters,
  type DatePreset,
  type FilterColumn,
  type PaymentModeFilter,
} from "./orders-column-filters";

// The funnel next to each filterable column header. Every option list is the application's own (order statuses, order
// sources, payment statuses, the CRM's salespeople and lead sources) - nothing is invented here. Selecting only ever
// changes the URL state through `onChange`; the server does the filtering.
const FULFILLMENT_LABELS: Record<string, string> = { UNFULFILLED: "Unfulfilled", PARTIALLY_FULFILLED: "Partially fulfilled", FULFILLED: "Fulfilled" };
const PAYMENT_MODE_OPTIONS: Option<PaymentModeFilter>[] = [
  { value: "COD", label: "COD" },
  { value: "PREPAID", label: "Prepaid" },
];
const PAYMENT_STATUS_OPTIONS: Option<PaymentStatusFilter>[] = [
  ...PAYMENT_STATUS_ORDER.map((value) => ({ value, label: PAYMENT_STATUS_LABELS[value] }) as Option<PaymentStatusFilter>),
  { value: "NONE", label: "Unpaid (no payment)" },
];

export interface HeaderFilterProps {
  filters: ColumnFilters;
  onChange: (patch: Partial<ColumnFilters>) => void;
  salespeople: { id: string; name: string }[];
  leadSources: { id: string; name: string }[];
  showSalesperson: boolean;
  /** Tags that exist on real orders, for the Tags filter. */
  tagOptions?: { tags: TagOption[]; loading?: boolean; error?: string | null };
}

const names = (selected: string[], options: Option[]) => selected.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ");

export function headerFilterNodes({ filters: f, onChange, salespeople, leadSources, showSalesperson, tagOptions }: HeaderFilterProps): Record<string, ReactNode> {
  const active = (c: FilterColumn) => isColumnActive(f, c);
  const sourceOptions: Option[] = ORDER_SOURCE_ORDER.map((value) => ({ value, label: ORDER_SOURCE_LABELS[value] }));
  const statusOptions: Option[] = ORDER_STATUS_ORDER.map((value) => ({ value, label: ORDER_STATUS_LABELS[value] }));
  const fulfillmentOptions: Option[] = FULFILLMENT_VALUES.map((value) => ({ value, label: FULFILLMENT_LABELS[value]! }));
  const salespersonOptions: Option[] = salespeople.map((p) => ({ value: p.id, label: p.name }));
  const leadSourceOptions: Option[] = leadSources.map((s) => ({ value: s.id, label: s.name }));

  const nodes: Record<string, ReactNode> = {
    Payment: (
      <ColumnFilter
        label="Payment"
        active={active("payment")}
        summary={[names(f.paymentMode, PAYMENT_MODE_OPTIONS), names(f.paymentStatus, PAYMENT_STATUS_OPTIONS)].filter(Boolean).join(" · ")}
        onClear={() => onChange({ paymentMode: [], paymentStatus: [] })}
        renderBody={() => (
          <div className="grid gap-3">
            <CheckList title="Mode" options={PAYMENT_MODE_OPTIONS} selected={f.paymentMode} onChange={(paymentMode) => onChange({ paymentMode })} />
            <CheckList title="Payment status" options={PAYMENT_STATUS_OPTIONS} selected={f.paymentStatus} onChange={(paymentStatus) => onChange({ paymentStatus })} />
          </div>
        )}
      />
    ),
    "Order source": (
      <ColumnFilter label="Order source" active={active("source")} summary={names(f.source, sourceOptions)} onClear={() => onChange({ source: [] })} renderBody={() => <CheckList options={sourceOptions} selected={f.source} onChange={(source) => onChange({ source: source as ColumnFilters["source"] })} />} />
    ),
    Status: (
      <ColumnFilter
        label="Status"
        active={active("status")}
        summary={[names(f.status, statusOptions), names(f.fulfillment, fulfillmentOptions)].filter(Boolean).join(" · ")}
        onClear={() => onChange({ status: [], fulfillment: [] })}
        renderBody={() => (
          <div className="grid gap-3">
            <CheckList title="Order status" options={statusOptions} selected={f.status} onChange={(status) => onChange({ status: status as ColumnFilters["status"] })} />
            <CheckList title="Fulfilment" options={fulfillmentOptions} selected={f.fulfillment} onChange={(fulfillment) => onChange({ fulfillment })} />
          </div>
        )}
      />
    ),
    "Lead source": (
      <ColumnFilter label="Lead source" active={active("leadSource")} summary={names(f.leadSourceId, leadSourceOptions)} onClear={() => onChange({ leadSourceId: [] })} renderBody={() => <CheckList options={leadSourceOptions} selected={f.leadSourceId} onChange={(leadSourceId) => onChange({ leadSourceId })} emptyText="No lead sources" />} />
    ),
    Tags: <OrdersTagsFilter selected={f.tags} onChange={(tags) => onChange({ tags })} available={tagOptions?.tags ?? []} loading={tagOptions?.loading} error={tagOptions?.error} />,
    Date: (
      <ColumnFilter
        label="Date"
        active={active("date")}
        summary={f.datePreset ? DATE_PRESET_LABELS[f.datePreset] : [f.dateFrom, f.dateTo].filter(Boolean).join(" → ")}
        onClear={() => onChange({ datePreset: undefined, dateFrom: undefined, dateTo: undefined })}
        renderBody={(close) => (
          <div className="grid gap-2">
            <RadioList
              name="Date"
              value={f.datePreset ?? null}
              options={DATE_PRESETS.map((p) => ({ value: p, label: DATE_PRESET_LABELS[p] }))}
              onPick={(v) => {
                onChange(v === null ? { datePreset: undefined, dateFrom: undefined, dateTo: undefined } : { datePreset: v as DatePreset });
                close();
              }}
            />
            <RangeInputs
              fromLabel="From"
              toLabel="To"
              type="date"
              initialFrom={f.datePreset ? undefined : f.dateFrom}
              initialTo={f.datePreset ? undefined : f.dateTo}
              validate={(from, to) => (from && to && from > to ? "The “From” date must not be after the “To” date." : null)}
              onApply={(from, to) => {
                onChange({ datePreset: undefined, dateFrom: from || undefined, dateTo: to || undefined });
                close();
              }}
            />
          </div>
        )}
      />
    ),
    Total: (
      <ColumnFilter
        label="Total"
        active={active("total")}
        summary={[f.totalMin !== undefined ? `≥ ₹${f.totalMin}` : "", f.totalMax !== undefined ? `≤ ₹${f.totalMax}` : ""].filter(Boolean).join(" ")}
        onClear={() => onChange({ totalMin: undefined, totalMax: undefined })}
        renderBody={(close) => (
          <div className="grid gap-2">
            <RadioList
              name="Total"
              value={activeTotalPreset(f)}
              options={TOTAL_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              onPick={(v) => {
                const preset = TOTAL_PRESETS.find((p) => p.key === v);
                onChange({ totalMin: preset ? String(preset.min) : undefined, totalMax: preset?.max !== undefined ? String(preset.max) : undefined });
                close();
              }}
            />
            <RangeInputs
              fromLabel="Minimum"
              toLabel="Maximum"
              type="number"
              initialFrom={activeTotalPreset(f) ? undefined : f.totalMin}
              initialTo={activeTotalPreset(f) ? undefined : f.totalMax}
              validate={(from, to) => {
                const bad = (v: string) => v !== "" && !/^\d+(\.\d{1,2})?$/.test(v);
                if (bad(from) || bad(to)) return "Enter a valid amount.";
                if (from && to && Number(from) > Number(to)) return "Minimum must not exceed maximum.";
                return null;
              }}
              onApply={(from, to) => {
                onChange({ totalMin: from || undefined, totalMax: to || undefined });
                close();
              }}
            />
          </div>
        )}
      />
    ),
  };
  // A salesperson only ever sees their own orders (the server enforces it); the filter is for roles that can see several.
  if (showSalesperson) {
    nodes.Salesperson = (
      <ColumnFilter label="Salesperson" active={active("salesperson")} summary={names(f.salespersonId, salespersonOptions)} onClear={() => onChange({ salespersonId: [] })} renderBody={() => <CheckList options={salespersonOptions} selected={f.salespersonId} onChange={(salespersonId) => onChange({ salespersonId })} emptyText="No salespeople" />} />
    );
  }
  return nodes;
}
