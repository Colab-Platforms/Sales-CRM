"use client";

import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateTemplateMutation, useUpdateTemplateMutation } from "@/lib/api-client/mutations/whatsapp-templates.mutations";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import type { WhatsAppProvider, WhatsAppTemplate } from "@/lib/api-client/types/whatsapp-templates.types";

// Same {{name}} rule the backend enforces (whatsapp.template.variables.ts) - checked here only to
// give instant feedback; the server is still the source of truth for what actually gets saved.
const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
function previewVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) seen.add(name);
  }
  return [...seen];
}

interface TemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: WhatsAppTemplate;
  onSaved?: () => void;
}

export function TemplateFormDialog({ open, onOpenChange, template, onSaved }: TemplateFormDialogProps) {
  const isEdit = Boolean(template);
  const [name, setName] = useState(template?.name ?? "");
  const [provider, setProvider] = useState<WhatsAppProvider>(template?.provider ?? "AISENSY");
  const [category, setCategory] = useState(template?.category ?? "");
  const [language, setLanguage] = useState(template?.language ?? "en");
  const [body, setBody] = useState(template?.body ?? "");

  const createMutation = useCreateTemplateMutation();
  const updateMutation = useUpdateTemplateMutation();
  const pending = createMutation.isPending || updateMutation.isPending;
  const variables = useMemo(() => previewVariables(body), [body]);

  function reset() {
    setName(template?.name ?? "");
    setProvider(template?.provider ?? "AISENSY");
    setCategory(template?.category ?? "");
    setLanguage(template?.language ?? "en");
    setBody(template?.body ?? "");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const onSuccess = () => {
      toast.success(isEdit ? "Template updated." : "Template created as a draft.");
      onOpenChange(false);
      onSaved?.();
    };
    const onError = (error: unknown) => toast.error(getErrorMessage(error, "Could not save the template."));

    if (isEdit && template) {
      updateMutation.mutate({ id: template.id, input: { name, category: category || undefined, language, body } }, { onSuccess, onError });
    } else {
      createMutation.mutate({ name, provider, category: category || undefined, language, body }, { onSuccess, onError });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Local details only - this does not change the template's status with the provider."
                : "Created as a local draft. It is not sent to the provider automatically; approval status is only ever set by a real sync."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="template-name">Name</Label>
              <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} required />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="template-provider">Provider</Label>
                <Select
                  value={provider}
                  items={PROVIDER_LABELS}
                  onValueChange={(v) => v && setProvider(v as WhatsAppProvider)}
                  disabled={isEdit}
                >
                  <SelectTrigger id="template-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDER_LABELS) as WhatsAppProvider[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="template-language">Language</Label>
                <Input id="template-language" value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={10} placeholder="en" required />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="template-category">Category (optional)</Label>
              <Input id="template-category" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={50} placeholder="e.g. UTILITY, MARKETING" />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="template-body">Body</Label>
              <textarea
                id="template-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4096}
                rows={5}
                required
                placeholder="Hi {{customer_name}}, your order {{order_number}} has shipped."
                className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              />
              <p className="text-xs text-muted-foreground">
                {variables.length > 0 ? `Variables: ${variables.join(", ")}` : "No {{variables}} in this body yet."}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {isEdit ? "Save changes" : "Create draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
