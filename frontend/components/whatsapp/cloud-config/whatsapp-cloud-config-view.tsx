"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { whatsappCloudConfigQueryOptions } from "@/lib/api-client/queries/whatsapp-cloud-config.queries";
import {
  useResetWhatsAppCloudConfigMutation,
  useSaveWhatsAppCloudConfigMutation,
  useTestWhatsAppCloudConfigMutation,
} from "@/lib/api-client/mutations/whatsapp-cloud-config.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PasswordInput } from "@/components/ui/password-input";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { WhatsAppCloudConfig } from "@/lib/api-client/types/whatsapp-cloud-config.types";

function ConnectionBadge({ config }: { config: WhatsAppCloudConfig | null }) {
  if (!config) return <Badge variant="secondary">Not Connected</Badge>;
  if (!config.decryptable) {
    return (
      <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
        Stored credentials cannot be decrypted
      </Badge>
    );
  }
  return config.isActive ? (
    <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Connected</Badge>
  ) : (
    <Badge variant="secondary">Inactive</Badge>
  );
}

function ConfigForm({ existing, defaultAiModel, onSaved }: { existing: WhatsAppCloudConfig | null; defaultAiModel: string; onSaved: () => void }) {
  const saveConfig = useSaveWhatsAppCloudConfigMutation();
  const [phoneNumberId, setPhoneNumberId] = useState(existing?.phoneNumberId ?? "");
  const [businessAccountId, setBusinessAccountId] = useState(existing?.businessAccountId ?? "");
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState(existing?.displayPhoneNumber ?? "");
  const [businessName, setBusinessName] = useState(existing?.businessName ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [aiEnabled, setAiEnabled] = useState(existing?.aiEnabled ?? false);
  const [aiModel, setAiModel] = useState(existing?.aiModel ?? defaultAiModel);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // A saved, readable config lets a blank secret keep its stored value; a missing or undecryptable
  // one needs everything entered again.
  const canKeepSecrets = Boolean(existing?.decryptable);

  function submit() {
    saveConfig.mutate(
      {
        phoneNumberId,
        businessAccountId,
        displayPhoneNumber: displayPhoneNumber || undefined,
        businessName: businessName || undefined,
        credentials: { accessToken, appSecret, verifyToken },
        ai: { enabled: aiEnabled, provider: "gemini", model: aiModel.trim(), geminiApiKey },
        confirmOverwrite: Boolean(existing),
      },
      {
        onSuccess: () => {
          toast.success("WhatsApp Cloud API configuration saved.");
          setAccessToken("");
          setAppSecret("");
          setVerifyToken("");
          setGeminiApiKey("");
          onSaved();
        },
      },
    );
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (existing) {
      setConfirmOpen(true);
      return;
    }
    submit();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cfg-phone-number-id">Phone Number ID</Label>
          <Input id="cfg-phone-number-id" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cfg-waba-id">WhatsApp Business Account ID</Label>
          <Input id="cfg-waba-id" value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cfg-display-number">Display Phone Number</Label>
          <Input id="cfg-display-number" placeholder="+91 98765 00000" value={displayPhoneNumber} onChange={(e) => setDisplayPhoneNumber(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cfg-business-name">Business Name</Label>
          <Input id="cfg-business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cfg-access-token">Permanent Access Token</Label>
        <PasswordInput
          id="cfg-access-token"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder={canKeepSecrets ? "Saved - leave blank to keep, or enter to replace" : undefined}
          required={!canKeepSecrets}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cfg-app-secret">Meta App Secret</Label>
        <PasswordInput
          id="cfg-app-secret"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
          placeholder={canKeepSecrets ? "Saved - leave blank to keep, or enter to replace" : undefined}
          required={!canKeepSecrets}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cfg-verify-token">Webhook Verify Token</Label>
        <PasswordInput
          id="cfg-verify-token"
          value={verifyToken}
          onChange={(e) => setVerifyToken(e.target.value)}
          placeholder={canKeepSecrets ? "Saved - leave blank to keep, or enter to replace" : "A string you choose - enter the same value in Meta"}
          required={!canKeepSecrets}
        />
      </div>

      <div className="space-y-4 border-t pt-4">
        <div>
          <h3 className="text-sm font-semibold">AI Order Taking</h3>
          <p className="text-xs text-muted-foreground">
            Lets the AI read WhatsApp messages and collect order details. It never places an order itself - the CRM asks the
            customer to confirm first. AI is still switched on per conversation from the WhatsApp inbox.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input id="cfg-ai-enabled" type="checkbox" className="size-4 accent-primary" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
          AI order taking enabled
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cfg-ai-provider">AI Provider</Label>
            <NativeSelect id="cfg-ai-provider" value="gemini" onChange={() => {}}>
              <option value="gemini">Gemini</option>
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-ai-model">Gemini Model</Label>
            <Input id="cfg-ai-model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder={defaultAiModel} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cfg-gemini-key">Gemini API Key</Label>
          <PasswordInput
            id="cfg-gemini-key"
            value={geminiApiKey}
            onChange={(e) => setGeminiApiKey(e.target.value)}
            placeholder={existing?.hasGeminiApiKey ? "Saved - leave blank to keep, or enter to replace" : "Paste your key from Google AI Studio"}
          />
        </div>
      </div>

      {saveConfig.error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {getErrorMessage(saveConfig.error, "Failed to save configuration.")}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={saveConfig.isPending}>
          {saveConfig.isPending ? "Saving..." : "Save Configuration"}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Replace existing configuration?</DialogTitle>
            <DialogDescription>
              This updates the saved phone number, business account, credentials and AI settings. Any secret you left blank
              is kept as it is. If you change the verify token, update it in Meta too or webhook deliveries will be rejected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                submit();
              }}
              disabled={saveConfig.isPending}
            >
              Replace Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

function ResetConfigDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const resetConfig = useResetWhatsAppCloudConfigMutation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Reset WhatsApp Cloud API configuration?</DialogTitle>
          <DialogDescription>
            This permanently deletes the saved phone number, business account and credentials. Messaging and
            webhook processing stop immediately until it is reconfigured.
          </DialogDescription>
        </DialogHeader>
        {resetConfig.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(resetConfig.error, "Failed to reset configuration.")}
          </div>
        ) : null}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={resetConfig.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={resetConfig.isPending}
            onClick={() =>
              resetConfig.mutate(undefined, {
                onSuccess: () => {
                  toast.success("WhatsApp Cloud API configuration reset.");
                  onOpenChange(false);
                },
              })
            }
          >
            {resetConfig.isPending ? "Resetting..." : "Reset Configuration"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebhookCard({ webhookUrl }: { webhookUrl: string | undefined }) {
  async function copy() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Could not copy - select the URL and copy it manually.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook</CardTitle>
        <CardDescription>
          In Meta → WhatsApp → Configuration, set this as the callback URL and paste the Webhook Verify Token from above. Subscribe to
          the &quot;messages&quot; field.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <Label htmlFor="cfg-webhook-url">Callback URL</Label>
        <div className="flex gap-2">
          <Input id="cfg-webhook-url" readOnly value={webhookUrl ?? "Loading…"} onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" onClick={copy} disabled={!webhookUrl} aria-label="Copy webhook URL">
            <Copy data-icon="inline-start" />
            Copy
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const SETUP_STEPS = [
  { title: "Create Meta App", body: "In developers.facebook.com, create a Business app and add it to your Meta Business account." },
  { title: "Add WhatsApp Product", body: "From the app dashboard, add the WhatsApp product and select (or create) a WhatsApp Business Account and phone number." },
  { title: "Get API Credentials", body: "Copy the Phone Number ID, WhatsApp Business Account ID, and generate a permanent access token (System User token) and the App Secret from App Settings → Basic." },
  { title: "Configure Webhook", body: `In WhatsApp → Configuration, set the callback URL and verify token below, then subscribe to messages and message status updates.` },
];

export function WhatsAppCloudConfigView() {
  const { data, isPending, isError, error } = useQuery(whatsappCloudConfigQueryOptions());
  const testConnection = useTestWhatsAppCloudConfigMutation();
  const [resetOpen, setResetOpen] = useState(false);

  const config = data?.configured ? data.config : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="WhatsApp Config" description="Connect the official Meta WhatsApp Cloud API and set up AI order taking. Secrets are encrypted at rest and never shown again after saving." />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Connection Status
          </CardTitle>
          <CardDescription>
            <ConnectionBadge config={config} />
          </CardDescription>
        </CardHeader>
        {config ? (
          <CardContent className="space-y-4">
            {!config.decryptable ? (
              <div className="sketch-outline flex items-start gap-2 border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  Stored credentials could not be decrypted (the encryption key may have changed). Reset and re-enter
                  the configuration below.
                </span>
              </div>
            ) : null}

            {config.decryptable ? (
              <p className="text-sm text-muted-foreground">
                AI order taking: <span className="font-medium text-foreground">{config.aiEnabled ? "Enabled" : "Disabled"}</span> · Gemini
                {config.aiModel ? ` (${config.aiModel})` : ""} · API key {config.hasGeminiApiKey ? "saved" : "not saved (server GEMINI_API_KEY is used if set)"}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={testConnection.isPending || !config.decryptable}
                onClick={() =>
                  testConnection.mutate(undefined, {
                    onSuccess: (result) => (result.success ? toast.success(result.message) : toast.error(result.message)),
                    onError: (err) => toast.error(getErrorMessage(err, "Test connection failed.")),
                  })
                }
              >
                {testConnection.isPending ? "Testing..." : "Test Connection"}
              </Button>
              <Button type="button" variant="destructive" onClick={() => setResetOpen(true)}>
                Reset Configuration
              </Button>
            </div>

            {testConnection.data ? (
              <div className={`sketch-outline flex items-center gap-2 p-3 text-sm ${testConnection.data.success ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
                {testConnection.data.success ? <CircleCheck className="size-4 shrink-0" /> : <CircleAlert className="size-4 shrink-0" />}
                <span>
                  {testConnection.data.message}
                  {testConnection.data.verifiedName ? ` — ${testConnection.data.verifiedName}` : ""}
                  {testConnection.data.displayPhoneNumber ? ` (${testConnection.data.displayPhoneNumber})` : ""}
                  {testConnection.data.businessAccountName ? ` · Account: ${testConnection.data.businessAccountName}` : ""}
                </span>
              </div>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{config ? "Replace Configuration" : "Save Configuration"}</CardTitle>
          <CardDescription>
            {config
              ? "Secrets are never shown again after saving. Leave a secret blank to keep the saved one, or enter a new value to replace it."
              : "Enter your Meta WhatsApp Cloud API credentials and, optionally, your Gemini AI settings."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : isError ? (
            <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {getErrorMessage(error, "Failed to load WhatsApp Cloud API configuration.")}
            </div>
          ) : (
            <ConfigForm key={config?.updatedAt ?? "new"} existing={config} defaultAiModel={data?.defaultAiModel ?? "gemini-3.5-flash-lite"} onSaved={() => {}} />
          )}
        </CardContent>
      </Card>

      <WebhookCard webhookUrl={data?.webhookUrl} />

      <Card>
        <CardHeader>
          <CardTitle>Setup Instructions</CardTitle>
          <CardDescription>Follow these steps in the Meta Developer dashboard before saving credentials here.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {SETUP_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
                <div>
                  <p className="font-medium">{step.title}</p>
                  <p className="text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <ResetConfigDialog open={resetOpen} onOpenChange={setResetOpen} />
    </div>
  );
}
