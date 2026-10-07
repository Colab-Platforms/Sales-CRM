"use client";

import { MessageCircle } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { selectedTemplate, whatsappBlockReason, type WhatsAppPaymentChoice, type WhatsAppPaymentOptions } from "@/lib/whatsapp-payment";

interface Props {
  options: WhatsAppPaymentOptions | null;
  loading: boolean;
  error?: string | null;
  choice: WhatsAppPaymentChoice;
  onChange: (next: WhatsAppPaymentChoice) => void;
  disabled?: boolean;
}

// Create Order (prepaid): "Payment Link - Don't send / Send via WhatsApp". With WhatsApp: pick an approved Meta payment template (default
// prepaid_template, listed from the server - never hardcoded here) and confirm the customer's WhatsApp consent. The block reason explains
// exactly what is still missing; the server enforces all of it again.
export function WhatsAppPaymentSection({ options, loading, error, choice, onChange, disabled }: Props) {
  const template = selectedTemplate(options, choice);
  const reason = whatsappBlockReason(options, loading, choice);
  const consentRecorded = options?.consent === "OPTED_IN";

  return (
    <div className="grid gap-3 rounded-xl border-[1.5px] border-border bg-card p-4" data-testid="whatsapp-payment">
      <div className="flex items-center gap-2">
        <MessageCircle className="size-4 text-muted-foreground" aria-hidden />
        <p className="text-sm font-semibold">Payment Link</p>
      </div>

      <div role="radiogroup" aria-label="Payment link" className="flex flex-wrap gap-2">
        {([[false, "Don't send"], [true, "Send via WhatsApp"]] as const).map(([send, label]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={choice.send === send}
            disabled={disabled}
            onClick={() => onChange({ ...choice, send })}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${choice.send === send ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {choice.send ? (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="wa-template" className="text-xs">WhatsApp Template</Label>
            <NativeSelect id="wa-template" value={template?.id ?? ""} disabled={disabled || loading || !options || options.templates.length === 0} onChange={(e) => onChange({ ...choice, templateId: e.target.value })}>
              {options?.templates.length ? null : <option value="">{loading ? "Loading templates…" : "No approved payment template"}</option>}
              {options?.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.language}
                </option>
              ))}
            </NativeSelect>
            {template ? <p className="text-xs text-muted-foreground">Sends: {template.variables.join(", ")}</p> : null}
          </div>

          <div className="grid gap-1">
            {consentRecorded ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">WhatsApp consent already recorded for this customer.</p>
            ) : (
              <>
                <p className="text-sm text-amber-700 dark:text-amber-400">{options?.consent === "OPTED_OUT" ? "Customer has opted out of WhatsApp messages." : "Customer has not given WhatsApp consent."}</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={choice.consent} disabled={disabled || options?.consent === "OPTED_OUT"} onChange={(e) => onChange({ ...choice, consent: e.target.checked })} />
                <span>
                  Customer has agreed to receive WhatsApp updates
                  <span className="block text-xs text-muted-foreground">Required before sending a business-initiated WhatsApp message.</span>
                </span>
              </label>
              </>
            )}
          </div>

          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {reason ? <p role="alert" className="text-xs text-destructive">{reason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
