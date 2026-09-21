"use client";

import { useQuery } from "@tanstack/react-query";
import { MessageCircle, CircleCheck, CircleAlert } from "lucide-react";
import { whatsappStatusQueryOptions } from "@/lib/api-client/queries/whatsapp.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PROVIDER_LABELS: Record<string, string> = { AISENSY: "AiSensy", GUPSHUP: "Gupshup" };

export function WhatsAppStatusView() {
  const { data, isPending, isError, error } = useQuery(whatsappStatusQueryOptions());

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp Integration</h1>
        <p className="text-sm text-muted-foreground">Provider connection status for WhatsApp messaging (E7.1 foundation).</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Provider status
          </CardTitle>
          <CardDescription>Configured via backend environment variables. No credentials are ever shown here.</CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : isError ? (
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(error, "Could not load WhatsApp status.")}
            </p>
          ) : data.configured ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Configured</Badge>
                <span className="text-sm font-medium">{PROVIDER_LABELS[data.provider ?? ""] ?? data.provider}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Messages can be sent from a customer&apos;s profile, and inbound messages/delivery updates are received via webhook.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <CircleAlert className="size-4 text-muted-foreground" />
                <Badge variant="secondary">Not Configured</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                WhatsApp messaging is off. The rest of the CRM works normally, and no message will be sent until a provider is configured.
              </p>
              {data.problems && data.problems.length > 0 && (
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {data.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
