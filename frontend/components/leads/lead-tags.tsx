import { cn } from "@/lib/utils";
import type { CustomerClass, SegmentTag } from "@/lib/api-client/types/lead.types";

// The two independent tags a lead can carry, shown side by side everywhere the lead appears:
//   - customer classification (Repeat / Loyal / VIP), from the customer's real order count
//   - campaign segments (any number, admin-defined, each with its own colour)
// Neither replaces the other.

export const CUSTOMER_CLASS_LABELS: Record<CustomerClass, string> = { REPEAT: "Repeat", LOYAL: "Loyal", VIP: "VIP" };

const CLASS_STYLES: Record<CustomerClass, string> = {
  REPEAT: "border-sky-500/40 bg-sky-500/15 text-sky-800 dark:text-sky-200",
  LOYAL: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  VIP: "border-amber-500/50 bg-amber-500/20 text-amber-900 dark:text-amber-200",
};

const PILL = "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none whitespace-nowrap";

export function CustomerClassTag({ value, className }: { value: CustomerClass | null | undefined; className?: string }) {
  if (!value) return null;
  return (
    <span data-testid="customer-class-tag" data-class={value} title="Customer classification (from order history)" className={cn(PILL, CLASS_STYLES[value], className)}>
      {CUSTOMER_CLASS_LABELS[value]}
    </span>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A campaign segment tag in the segment's own colour (a tinted background, a border and a darkened text colour of the same hue). */
export function SegmentTagPill({ segment, className }: { segment: Pick<SegmentTag, "name" | "color" | "isActive">; className?: string }) {
  const color = HEX.test(segment.color) ? segment.color : "#6366f1";
  return (
    <span
      data-testid="segment-tag"
      title={`Campaign segment${segment.isActive ? "" : " (inactive)"}`}
      className={cn(PILL, segment.isActive ? "" : "opacity-60", className)}
      style={{ backgroundColor: `${color}26`, borderColor: `${color}80`, color: `color-mix(in srgb, ${color} 65%, black)` }}
    >
      <span className="truncate">{segment.name}</span>
    </span>
  );
}

/** Classification first, then every campaign segment. Renders nothing when the lead has neither. */
export function LeadTags({ customerClass, segments, className }: { customerClass?: CustomerClass | null; segments?: SegmentTag[] | null; className?: string }) {
  const list = segments ?? [];
  if (!customerClass && list.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} data-testid="lead-tags">
      <CustomerClassTag value={customerClass} />
      {list.map((s) => (
        <SegmentTagPill key={s.id} segment={s} />
      ))}
    </div>
  );
}
