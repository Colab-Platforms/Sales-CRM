"use client";

import { useState } from "react";
import { AlarmClock, CalendarClock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { MIN_GAP_MS, FOLLOW_UP_TYPE_LABEL, formatWhen, leadDisplayName, toLocalInputValue } from "./follow-up-utils";
import type { LeadFollowUp } from "@/lib/api-client/types/tasks.types";
import { useFollowUpConflict } from "./use-follow-up-conflict";

const formatTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

interface Preset {
  label: string;
  at: () => Date;
}

function tomorrowAt(hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

const PRESETS: Preset[] = [
  { label: "In 30 min", at: () => new Date(Date.now() + 30 * 60_000) },
  { label: "In 1 hour", at: () => new Date(Date.now() + 60 * 60_000) },
  { label: "In 3 hours", at: () => new Date(Date.now() + 3 * 60 * 60_000) },
  { label: "Tomorrow 11 AM", at: () => tomorrowAt(11) },
  { label: "Tomorrow 4 PM", at: () => tomorrowAt(16) },
];

/**
 * Picks when to be reminded about a lead. `value` is a datetime-local string (local time);
 * convert with localInputToIso before sending it to the API.
 */
export function FollowUpTimePicker({
  id,
  label,
  leadId,
  current,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  /** The lead being scheduled, so its own existing reminder isn't counted as a clash. */
  leadId?: string;
  /** The reminder already set on this lead, if any: shown as "currently scheduled" and replaced on save. */
  current?: LeadFollowUp | null;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // Captured once when the picker opens; the backend re-checks "not in the past" on save anyway.
  const [openedAt] = useState(() => Date.now());
  // Which preset produced the current value, so its chip stays highlighted until the time is edited.
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const currentMs = current ? new Date(current.scheduledAt).getTime() : null;
  const currentValue = currentMs === null ? null : toLocalInputValue(new Date(currentMs));
  // An overdue existing time stays a valid value (min must not sit above it, or the browser blocks the form).
  const min = toLocalInputValue(new Date(Math.min(openedAt, currentMs ?? openedAt)));
  const isPast = Boolean(value) && value !== currentValue && new Date(value).getTime() < openedAt - 60_000;
  const { conflict, nextFree } = useFollowUpConflict(leadId, value);

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border bg-muted/30 p-2.5">
      <Label htmlFor={id} className="flex items-center gap-1.5 text-xs font-semibold">
        <CalendarClock className="size-3.5 text-primary" />
        {label}
      </Label>
      {current ? (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md bg-card px-2.5 py-1.5 text-xs">
          <AlarmClock className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Currently scheduled:</span>
          <span className={cn("font-semibold", currentMs !== null && currentMs < openedAt ? "text-destructive" : "text-foreground")}>
            {formatWhen(current.scheduledAt)}
          </span>
          <span className="text-muted-foreground">· {FOLLOW_UP_TYPE_LABEL[current.type]}</span>
          {value && value !== currentValue ? <span className="text-muted-foreground">→ will change to the time below</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            disabled={disabled}
            onClick={() => {
              setActivePreset(preset.label);
              onChange(toLocalInputValue(preset.at()));
            }}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50",
              activePreset === preset.label && value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:bg-muted",
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <Input
        id={id}
        type="datetime-local"
        value={value}
        min={min}
        disabled={disabled}
        onChange={(e) => {
          setActivePreset(null);
          onChange(e.target.value);
        }}
        aria-invalid={isPast || undefined}
      />
      {conflict ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <span>
            {leadDisplayName(conflict.lead)} already has a reminder at {formatTime(conflict.scheduledAt)} — keep at least {MIN_GAP_MS / 60_000} minutes between calls.
          </span>
          {nextFree ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setActivePreset(null);
                onChange(nextFree);
              }}
              className="rounded-full border border-destructive/40 bg-card px-2 py-0.5 font-medium hover:bg-muted"
            >
              Use {formatTime(nextFree)}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {isPast ? (
          <span className="text-destructive">That time has already passed.</span>
        ) : (
          "You'll get a reminder 5 minutes before, and a pop-up at this time."
        )}
      </p>
    </div>
  );
}
