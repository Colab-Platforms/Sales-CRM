"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plug, Plus } from "lucide-react";
import { sourcesQueryOptions, sourceEventsQueryOptions } from "@/lib/api-client/queries/source.queries";
import {
  useCreateSourceMutation,
  useUpdateSourceMutation,
  useToggleSourceStatusMutation,
} from "@/lib/api-client/mutations/source.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { Source, SourceType } from "@/lib/api-client/types/source.types";

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  MANUAL: "Manual",
  CSV: "CSV Import",
  META: "Meta Lead Ads",
  SHOPIFY: "Shopify",
  API: "API",
};

function CreateSourceModalContent({ onDone }: { onDone: () => void }) {
  const createSource = useCreateSourceMutation();
  const [type, setType] = useState<SourceType>("META");
  const [name, setName] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [pageAccessToken, setPageAccessToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [adminApiToken, setAdminApiToken] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const credentials: Record<string, string> =
      type === "META"
        ? { appSecret, pageAccessToken }
        : type === "SHOPIFY"
          ? { webhookSecret, adminApiToken }
          : {};

    createSource.mutate(
      {
        name,
        type,
        externalAccountId: externalAccountId || undefined,
        credentials: Object.values(credentials).some(Boolean) ? credentials : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Source added successfully.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>Add Source</DialogTitle>
        <DialogDescription>Connect a lead channel so incoming leads flow in automatically.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="source-type">Provider</Label>
          <NativeSelect
            id="source-type"
            value={type}
            onChange={(e) => setType(e.target.value as SourceType)}
          >
            <option value="META">Meta Lead Ads</option>
            <option value="SHOPIFY">Shopify</option>
            <option value="MANUAL">Manual</option>
            <option value="API">API</option>
          </NativeSelect>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="source-name">Name</Label>
          <Input
            id="source-name"
            placeholder="e.g. Main Facebook Page"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>

        {type === "META" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="source-page-id">Page ID</Label>
              <Input
                id="source-page-id"
                placeholder="Facebook Page ID"
                value={externalAccountId}
                onChange={(e) => setExternalAccountId(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="source-app-secret">App Secret</Label>
              <Input
                id="source-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="source-page-token">Page Access Token</Label>
              <Input
                id="source-page-token"
                type="password"
                value={pageAccessToken}
                onChange={(e) => setPageAccessToken(e.target.value)}
                required
              />
            </div>
          </>
        ) : null}

        {type === "SHOPIFY" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="source-shop-domain">Shop Domain</Label>
              <Input
                id="source-shop-domain"
                placeholder="my-store.myshopify.com"
                value={externalAccountId}
                onChange={(e) => setExternalAccountId(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="source-admin-token">Admin API Access Token</Label>
              <Input
                id="source-admin-token"
                type="password"
                value={adminApiToken}
                onChange={(e) => setAdminApiToken(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="source-webhook-secret">Webhook Secret</Label>
              <Input
                id="source-webhook-secret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                required
              />
            </div>
          </>
        ) : null}

        {createSource.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(createSource.error, "Failed to create source.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={createSource.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createSource.isPending}>
            {createSource.isPending ? "Adding..." : "Add Source"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function SourceEventsDialogContent({ source }: { source: Source }) {
  const { data: events, isPending } = useQuery(sourceEventsQueryOptions(source.id));

  return (
    <DialogContent className="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{source.name} — Recent Deliveries</DialogTitle>
        <DialogDescription>Last webhook events received for this source.</DialogDescription>
      </DialogHeader>
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : events && events.length > 0 ? (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {events.map((event) => (
            <div key={event.id} className="sketch-outline flex items-center justify-between p-2.5 text-sm">
              <div>
                <p className="font-medium">{new Date(event.receivedAt).toLocaleString()}</p>
                {event.errorMessage ? (
                  <p className="text-xs text-destructive">{event.errorMessage}</p>
                ) : null}
              </div>
              <Badge variant={event.status === "PROCESSED" ? "default" : event.status === "FAILED" ? "destructive" : "secondary"}>
                {event.status}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No webhook deliveries yet.</p>
      )}
    </DialogContent>
  );
}

function SourceRow({ source }: { source: Source }) {
  const [isEventsDialogOpen, setIsEventsDialogOpen] = useState(false);
  const toggleStatus = useToggleSourceStatusMutation();
  const isActive = source.status === "ACTIVE";

  return (
    <>
      <TableRow>
        <TableCell className="pl-5 font-semibold">{source.name}</TableCell>
        <TableCell>
          <Badge variant="outline">{SOURCE_TYPE_LABELS[source.type]}</Badge>
        </TableCell>
        <TableCell>
          <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Active" : "Inactive"}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : "Never"}
        </TableCell>
        <TableCell className="pr-5 text-right">
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setIsEventsDialogOpen(true)}>
              Events
            </Button>
            {isActive ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={toggleStatus.isPending}
                onClick={() =>
                  toggleStatus.mutate(
                    { id: source.id, status: "INACTIVE" },
                    { onSuccess: () => toast.success(`${source.name} deactivated`) },
                  )
                }
              >
                {toggleStatus.isPending ? "Deactivating..." : "Deactivate"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={toggleStatus.isPending}
                onClick={() =>
                  toggleStatus.mutate(
                    { id: source.id, status: "ACTIVE" },
                    { onSuccess: () => toast.success(`${source.name} reactivated`) },
                  )
                }
              >
                {toggleStatus.isPending ? "Reactivating..." : "Reactivate"}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={isEventsDialogOpen} onOpenChange={setIsEventsDialogOpen}>
        {isEventsDialogOpen ? <SourceEventsDialogContent source={source} /> : null}
      </Dialog>
    </>
  );
}

export default function SourcesPage() {
  const { data: sources, isPending, error } = useQuery(sourcesQueryOptions());
  const [isAddOpen, setIsAddOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sources"
        description="Connect Meta Lead Ads, Shopify, and other channels so leads flow in automatically."
        actions={
          <Button onClick={() => setIsAddOpen(true)}>
            <Plus />
            Add Source
          </Button>
        }
      />

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        {isAddOpen ? <CreateSourceModalContent onDone={() => setIsAddOpen(false)} /> : null}
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>All Sources</CardTitle>
          <CardDescription>
            {sources ? `${sources.length} source${sources.length === 1 ? "" : "s"} configured` : "Loading sources..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isPending ? (
            <div className="space-y-3 px-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="sketch-outline mx-5 border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {getErrorMessage(error, "Failed to load sources.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Synced</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources && sources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-14 text-center">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Plug className="size-9 text-muted-foreground/40" />
                        <p className="font-heading text-lg font-bold">No sources yet</p>
                        <p className="font-hand text-base text-muted-foreground">
                          Connect Meta Lead Ads or Shopify to start receiving leads automatically.
                        </p>
                        <Button className="mt-3" onClick={() => setIsAddOpen(true)}>
                          <Plus />
                          Add Source
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  sources?.map((source) => <SourceRow key={source.id} source={source} />)
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
