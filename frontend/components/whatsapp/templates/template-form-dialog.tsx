"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateTemplateMutation, useUpdateTemplateMutation } from "@/lib/api-client/mutations/whatsapp-templates.mutations";
import { whatsappCloudConfigQueryOptions } from "@/lib/api-client/queries/whatsapp-cloud-config.queries";
import { whatsappStatusQueryOptions } from "@/lib/api-client/queries/whatsapp.queries";
import { cn } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import {
  BODY_MAX,
  BUTTON_TEXT_MAX,
  BUTTON_TYPE_OPTIONS,
  CATEGORY_OPTIONS,
  FOOTER_MAX,
  HEADER_TEXT_MAX,
  HEADER_TYPE_OPTIONS,
  LANGUAGE_OPTIONS,
  MAX_BUTTONS,
  NAME_PATTERN,
  buttonKind,
  extractVariables,
  renderWhatsAppFormatting,
  substituteExamples,
} from "@/lib/whatsapp-template-builder";
import { useAuthStore } from "@/stores/auth-store";
import type { TemplateButton, TemplateButtonType, TemplateComponents, TemplateHeader, TemplateHeaderType, WhatsAppProvider, WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

const textareaClass =
  "w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

function Counter({ value, max }: { value: number; max: number }) {
  return <span className={cn("text-xs tabular-nums", value > max ? "text-destructive" : "text-muted-foreground")}>{value}/{max}</span>;
}

/** Which providers actually have SOME real configuration today - informational only (see the section below the
 *  provider select): the CRM still allows drafting for an unconfigured provider on purpose, exactly as it always
 *  has, since a draft is never sent anywhere on its own. */
function useConfiguredProviders(): Partial<Record<WhatsAppProvider, boolean>> {
  const token = useAuthStore((s) => s.token);
  const legacy = useQuery({ ...whatsappStatusQueryOptions(), enabled: Boolean(token) }).data;
  const meta = useQuery({ ...whatsappCloudConfigQueryOptions(), enabled: Boolean(token) }).data;
  return {
    AISENSY: legacy?.configured && legacy.provider === "AISENSY",
    GUPSHUP: legacy?.configured && legacy.provider === "GUPSHUP",
    META: Boolean(meta?.configured && meta.config.isActive),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// live preview - a WhatsApp-shaped bubble in the CRM's own card styling, never a copy of WhatsApp's actual chrome.

function TemplatePreview({ header, body, footer, buttons, examples }: { header?: TemplateHeader; body: string; footer?: string; buttons?: TemplateButton[]; examples: Record<string, string> }) {
  const rendered = renderWhatsAppFormatting(substituteExamples(body, examples));
  return (
    <div className="rounded-xl border-[1.5px] border-border bg-card p-4">
      <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Preview</p>
      <div className="mx-auto max-w-[320px] rounded-2xl rounded-tl-sm border border-border bg-muted/40 p-3 text-sm shadow-sm">
        {header?.type === "TEXT" && header.text ? <p className="mb-1.5 font-semibold">{header.text}</p> : null}
        {header && header.type !== "TEXT" ? (
          <div className="mb-1.5 flex h-24 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
            {header.type} placeholder{header.mediaUrl ? " (reference set)" : ""}
          </div>
        ) : null}
        {body.trim() ? <p className="leading-relaxed whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: rendered || "&nbsp;" }} /> : <p className="text-muted-foreground italic">Body preview will appear here…</p>}
        {footer ? <p className="mt-1.5 text-xs text-muted-foreground">{footer}</p> : null}
        {buttons && buttons.length > 0 ? (
          <div className="mt-2.5 -mx-3 -mb-3 border-t border-border/70">
            {buttons.map((b, i) => (
              <div key={i} className={cn("px-3 py-2 text-center text-sm font-medium text-primary", i > 0 && "border-t border-border/70")}>
                {b.text || "(button text)"}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">Approximate preview only - actual rendering varies by device and provider.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

interface TemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: WhatsAppTemplate;
  onSaved?: () => void;
}

export function TemplateFormDialog({ open, onOpenChange, template, onSaved }: TemplateFormDialogProps) {
  const isEdit = Boolean(template);
  const configured = useConfiguredProviders();

  const [name, setName] = useState(template?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [provider, setProvider] = useState<WhatsAppProvider>(template?.provider ?? "AISENSY");
  const [category, setCategory] = useState(template?.category ?? "");
  const [language, setLanguage] = useState(template?.language ?? "en");
  const [body, setBody] = useState(template?.body ?? "");
  const [footer, setFooter] = useState(template?.components?.footer ?? "");
  const [headerType, setHeaderType] = useState<TemplateHeaderType | "NONE">(template?.components?.header?.type ?? "NONE");
  const [headerText, setHeaderText] = useState(template?.components?.header?.text ?? "");
  const [headerMediaUrl, setHeaderMediaUrl] = useState(template?.components?.header?.mediaUrl ?? "");
  const [buttons, setButtons] = useState<TemplateButton[]>(template?.components?.buttons ?? []);
  const [examples, setExamples] = useState<Record<string, string>>(template?.components?.bodyExamples ?? {});

  const createMutation = useCreateTemplateMutation();
  const updateMutation = useUpdateTemplateMutation();
  const pending = createMutation.isPending || updateMutation.isPending;
  const variables = useMemo(() => extractVariables(body), [body]);

  // Drop example values for variables no longer in the body, and never lose one still present.
  function handleBodyChange(next: string) {
    setBody(next);
    const nextVariables = extractVariables(next);
    setExamples((prev) => Object.fromEntries(nextVariables.map((v) => [v, prev[v] ?? ""])));
  }

  function reset() {
    setName(template?.name ?? "");
    setNameTouched(false);
    setProvider(template?.provider ?? "AISENSY");
    setCategory(template?.category ?? "");
    setLanguage(template?.language ?? "en");
    setBody(template?.body ?? "");
    setFooter(template?.components?.footer ?? "");
    setHeaderType(template?.components?.header?.type ?? "NONE");
    setHeaderText(template?.components?.header?.text ?? "");
    setHeaderMediaUrl(template?.components?.header?.mediaUrl ?? "");
    setButtons(template?.components?.buttons ?? []);
    setExamples(template?.components?.bodyExamples ?? {});
  }

  const nameValid = NAME_PATTERN.test(name) && name.length > 0;
  const bodyValid = body.trim().length > 0 && body.length <= BODY_MAX;
  const headerValid = headerType === "NONE" || (headerType === "TEXT" ? headerText.trim().length > 0 && headerText.length <= HEADER_TEXT_MAX : headerMediaUrl.trim().length > 0);
  const buttonsValid =
    buttons.length <= MAX_BUTTONS &&
    new Set(buttons.map((b) => buttonKind(b.type))).size <= 1 &&
    buttons.every((b) => b.text.trim().length > 0 && b.text.length <= BUTTON_TEXT_MAX && (b.type !== "URL" || Boolean(b.url?.trim())) && (b.type !== "PHONE_NUMBER" || /^\+?[1-9]\d{6,14}$/.test(b.phoneNumber?.trim() ?? "")));
  const formValid = nameValid && bodyValid && headerValid && buttonsValid && Boolean(language.trim());

  function buildComponents(): TemplateComponents | undefined {
    const hasAny = headerType !== "NONE" || footer.trim() || buttons.length > 0 || variables.length > 0;
    if (!hasAny) return undefined;
    const header: TemplateHeader | undefined = headerType === "NONE" ? undefined : headerType === "TEXT" ? { type: "TEXT", text: headerText.trim() } : { type: headerType, mediaUrl: headerMediaUrl.trim() };
    const cleanExamples = Object.fromEntries(Object.entries(examples).filter(([, v]) => v.trim()));
    return {
      ...(header ? { header } : {}),
      ...(footer.trim() ? { footer: footer.trim() } : {}),
      ...(buttons.length > 0 ? { buttons } : {}),
      ...(Object.keys(cleanExamples).length > 0 ? { bodyExamples: cleanExamples } : {}),
    };
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formValid) {
      setNameTouched(true);
      return;
    }
    const components = buildComponents();
    const onSuccess = () => {
      toast.success(isEdit ? "Template updated." : "Saved as draft. Submit/approval must be completed through the configured provider flow (Sync from provider / Sync Meta templates).");
      onOpenChange(false);
      onSaved?.();
    };
    const onError = (error: unknown) => toast.error(getErrorMessage(error, "Could not save the template."));

    if (isEdit && template) {
      updateMutation.mutate({ id: template.id, input: { name, category: category || undefined, language, body, components: components ?? null } }, { onSuccess, onError });
    } else {
      createMutation.mutate({ name, provider, category: category || undefined, language, body, components }, { onSuccess, onError });
    }
  }

  function updateButton(index: number, patch: Partial<TemplateButton>) {
    setButtons((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-[min(1040px,calc(100vw-3rem))]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Local details only - this does not change the template's status with the provider."
                : "No provider in this CRM can create a real WhatsApp template through its API today (Meta/AiSensy/Gupshup only ever sync existing ones in). This is saved as a local draft - use it as a reference when you create the real template in the provider's own console, then Sync to bring in its approved status."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4 lg:grid-cols-[1fr_320px]">
            <div className="grid min-w-0 content-start gap-4">
              {/* A. Basic information */}
              <section className="grid gap-3 rounded-xl border-[1.5px] border-border bg-card p-4">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Basic information</h3>
                <div className="grid gap-1.5">
                  <Label htmlFor="template-name">Template name</Label>
                  <Input
                    id="template-name"
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                    onBlur={() => setNameTouched(true)}
                    maxLength={150}
                    placeholder="order_shipped_v1"
                    aria-invalid={nameTouched && !nameValid}
                    required
                  />
                  {nameTouched && !nameValid ? <p className="text-xs text-destructive">Lowercase letters, numbers and underscores only - no spaces or special characters.</p> : null}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="template-provider">Provider</Label>
                    <NativeSelect id="template-provider" value={provider} onChange={(e) => setProvider(e.target.value as WhatsAppProvider)} disabled={isEdit}>
                      {(Object.keys(PROVIDER_LABELS) as WhatsAppProvider[]).map((p) => (
                        <option key={p} value={p}>
                          {PROVIDER_LABELS[p]}
                          {configured[p] === false ? " (not configured)" : ""}
                        </option>
                      ))}
                    </NativeSelect>
                    {configured[provider] === false ? <p className="text-xs text-muted-foreground">This provider isn&apos;t configured yet - this template will be saved as a draft only.</p> : null}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="template-language">Language</Label>
                    <NativeSelect id="template-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGE_OPTIONS.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="template-category">Category</Label>
                  <NativeSelect id="template-category" value={category} onChange={(e) => setCategory(e.target.value)} className="max-w-[220px]">
                    <option value="">Select a category</option>
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0) + c.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </section>

              {/* B. Header */}
              <section className="grid gap-3 rounded-xl border-[1.5px] border-border bg-card p-4">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Header (optional)</h3>
                <NativeSelect value={headerType} onChange={(e) => setHeaderType(e.target.value as TemplateHeaderType | "NONE")} className="max-w-[220px]">
                  <option value="NONE">None</option>
                  {HEADER_TYPE_OPTIONS.map((h) => (
                    <option key={h.value} value={h.value}>
                      {h.label}
                    </option>
                  ))}
                </NativeSelect>
                {headerType === "TEXT" ? (
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="header-text">Header text</Label>
                      <Counter value={headerText.length} max={HEADER_TEXT_MAX} />
                    </div>
                    <Input id="header-text" value={headerText} onChange={(e) => setHeaderText(e.target.value)} maxLength={HEADER_TEXT_MAX} placeholder="Order update" />
                  </div>
                ) : null}
                {headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="header-media">Media reference URL</Label>
                    <Input id="header-media" value={headerMediaUrl} onChange={(e) => setHeaderMediaUrl(e.target.value)} placeholder="https://…" />
                    <p className="text-xs text-muted-foreground">
                      For your own record-keeping only - the CRM does not upload or send media. Use this exact reference when you create the real header in the provider&apos;s console.
                    </p>
                  </div>
                ) : null}
              </section>

              {/* C. Body */}
              <section className="grid gap-3 rounded-xl border-[1.5px] border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Body</h3>
                  <Counter value={body.length} max={BODY_MAX} />
                </div>
                <textarea
                  id="template-body"
                  value={body}
                  onChange={(e) => handleBodyChange(e.target.value)}
                  maxLength={BODY_MAX}
                  rows={5}
                  required
                  placeholder="Hi {{customer_name}}, your order {{order_number}} has shipped."
                  className={textareaClass}
                />
                <p className="text-xs text-muted-foreground">Formatting: *bold*, _italic_, ~strikethrough~. Insert a variable as {"{{name}}"}.</p>

                {variables.length > 0 ? (
                  <div className="grid gap-2 rounded-lg bg-muted/40 p-3">
                    <p className="text-xs font-medium">Variables</p>
                    {variables.map((v) => (
                      <div key={v} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2 text-sm">
                        <Badge variant="secondary" className="w-fit font-mono">{`{{${v}}}`}</Badge>
                        <Input value={examples[v] ?? ""} onChange={(e) => setExamples((prev) => ({ ...prev, [v]: e.target.value }))} placeholder="Example value" maxLength={200} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No {"{{variables}}"} in this body yet.</p>
                )}
              </section>

              {/* D. Footer */}
              <section className="grid gap-3 rounded-xl border-[1.5px] border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Footer (optional)</h3>
                  <Counter value={footer.length} max={FOOTER_MAX} />
                </div>
                <Input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={FOOTER_MAX} placeholder="Reply STOP to unsubscribe" />
              </section>

              {/* E. Interactive actions */}
              <section className="grid gap-3 rounded-xl border-[1.5px] border-border bg-card p-4">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Interactive actions (optional)</h3>
                {!buttonsValid && buttons.length > 0 ? (
                  <p className="text-xs text-destructive">
                    {buttons.length > MAX_BUTTONS ? `A template can have at most ${MAX_BUTTONS} buttons.` : "Quick replies cannot be mixed with URL/phone buttons in the same template. Fill in every button's required field."}
                  </p>
                ) : null}
                <div className="grid gap-2">
                  {buttons.map((b, i) => (
                    <div key={i} className="grid grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
                      <NativeSelect value={b.type} onChange={(e) => updateButton(i, { type: e.target.value as TemplateButtonType, url: undefined, phoneNumber: undefined })} size="sm">
                        {BUTTON_TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </NativeSelect>
                      <Input value={b.text} onChange={(e) => updateButton(i, { text: e.target.value })} maxLength={BUTTON_TEXT_MAX} placeholder="Button text" />
                      {b.type === "URL" ? (
                        <Input value={b.url ?? ""} onChange={(e) => updateButton(i, { url: e.target.value })} placeholder="https://…" />
                      ) : b.type === "PHONE_NUMBER" ? (
                        <Input value={b.phoneNumber ?? ""} onChange={(e) => updateButton(i, { phoneNumber: e.target.value })} placeholder="+919876543210" />
                      ) : (
                        <span className="text-xs text-muted-foreground">Sends the button text back as a reply</span>
                      )}
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => setButtons((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove button">
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={buttons.length >= MAX_BUTTONS}
                  onClick={() => setButtons((prev) => [...prev, { type: prev.length > 0 ? prev[0]!.type : "QUICK_REPLY", text: "" }])}
                >
                  <Plus data-icon="inline-start" />
                  Add button
                </Button>
              </section>
            </div>

            {/* F. Live preview */}
            <div className="content-start lg:sticky lg:top-0 lg:self-start">
              <TemplatePreview
                header={headerType === "NONE" ? undefined : headerType === "TEXT" ? { type: "TEXT", text: headerText } : { type: headerType, mediaUrl: headerMediaUrl }}
                body={body}
                footer={footer}
                buttons={buttons}
                examples={examples}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !formValid}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Save draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
