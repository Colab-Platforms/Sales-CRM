"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_RECIPIENTS, normalizeRecipient, validateRecipients } from "./report-automation-form";
import { maskPhone } from "./report-automation-schedule";

export type RecipientRow = { name?: string; phone: string; enabled?: boolean };

/** The people the report is sent to: one compact row each (name, masked number, active switch, remove). New numbers are typed once in the add form and are shown masked from then on. */
export function RecipientManager({ rows, onChange, listError }: { rows: RecipientRow[]; onChange: (next: RecipientRow[]) => void; listError?: string }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const activeCount = rows.filter((r) => r.enabled !== false).length;

  const add = () => {
    const candidate = { name: name.trim(), phone: normalizeRecipient(phone), enabled: true };
    // validate the whole resulting list so a duplicate or a full list is caught with the same rules the server applies
    const errors = validateRecipients([...rows, candidate], false);
    const message = errors[String(rows.length)] ?? errors.list;
    if (message) { setProblem(message); return; }
    onChange([...rows, candidate]);
    setName("");
    setPhone("");
    setProblem(null);
  };
  const patch = (i: number, p: Partial<RecipientRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="space-y-2" data-testid="recipients">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Recipients</h3>
        <span className="text-xs text-muted-foreground" data-testid="recipient-summary">{rows.length === 0 ? "None added" : `${activeCount} of ${rows.length} active`}</span>
      </div>

      {rows.length > 0 ? (
        <ul className="divide-y rounded-md border" data-testid="recipient-list">
          {rows.map((r, i) => (
            <li key={`${normalizeRecipient(r.phone)}-${i}`} className={`flex items-center gap-3 px-3 py-2 text-sm ${r.enabled === false ? "opacity-60" : ""}`}>
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <input type="checkbox" checked={r.enabled !== false} onChange={(e) => patch(i, { enabled: e.target.checked })} aria-label={`Send to ${r.name || maskPhone(normalizeRecipient(r.phone))}`} />
                <span className="min-w-0 flex-1 truncate font-medium">{r.name?.trim() || "Unnamed"}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{maskPhone(normalizeRecipient(r.phone))}</span>
              </label>
              <span className={`shrink-0 text-xs ${r.enabled === false ? "text-muted-foreground" : "text-emerald-600"}`}>{r.enabled === false ? "Disabled" : "Active"}</span>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${r.name || "recipient"}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No recipients yet. Add the WhatsApp numbers that should receive the report.</p>}

      <div className="flex flex-wrap items-start gap-2">
        <Input aria-label="New recipient name" className="h-8 w-40" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />
        <Input aria-label="New recipient WhatsApp number" className="h-8 w-48" value={phone} onChange={(e) => { setPhone(e.target.value); setProblem(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder="+919876543210" aria-invalid={Boolean(problem)} />
        <Button type="button" size="sm" variant="outline" onClick={add} disabled={!phone.trim() || rows.length >= MAX_RECIPIENTS} data-testid="add-recipient"><Plus data-icon="inline-start" />Add</Button>
      </div>
      {problem ? <p role="alert" className="text-xs text-destructive">{problem}</p> : null}
      {listError ? <p role="alert" className="text-xs text-destructive">{listError}</p> : null}
    </div>
  );
}
