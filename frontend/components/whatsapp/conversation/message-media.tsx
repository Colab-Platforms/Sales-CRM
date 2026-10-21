"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { FileText, ImageOff, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { whatsappHistoryApi } from "@/lib/api-client/endpoints/whatsapp-history.api";
import type { MessageMediaInfo } from "@/lib/api-client/types/whatsapp-history.types";

// A customer's file (payment screenshot, document, voice note...) inside a conversation. The browser never sees the provider's URL or token: the bytes come from the CRM's own
// authenticated route and are shown from a short-lived blob URL. Showing a file is display only - it never marks an order paid.

export type MediaState = "idle" | "loading" | "ready" | "expired" | "error";

const LABEL: Record<MessageMediaInfo["kind"], string> = { image: "Image", video: "Video", audio: "Audio", document: "Document", sticker: "Sticker", unknown: "File" };
const AUTO_LOAD = new Set<MessageMediaInfo["kind"]>(["image", "sticker"]);

/** Pure view of the media in one of its states - what the tests render. */
export function MediaFrame({ media, state, url, onLoad }: { media: MessageMediaInfo; state: MediaState; url: string | null; onLoad: () => void }) {
  const label = media.filename ?? LABEL[media.kind];
  if (media.kind === "unknown") {
    return (
      <p data-testid="media-unavailable" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <ImageOff className="size-4 shrink-0" /> A file was received but its details were not recorded, so it cannot be shown here. Ask the customer to send it again.
      </p>
    );
  }
  if (state === "expired") {
    return (
      <p data-testid="media-unavailable" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <ImageOff className="size-4 shrink-0" /> {label} is no longer available from WhatsApp (it may have expired).
      </p>
    );
  }
  if (state === "error") {
    return (
      <div data-testid="media-error" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <ImageOff className="size-4 shrink-0" /> Could not load {label.toLowerCase()}.
        <Button type="button" size="sm" variant="outline" onClick={onLoad}>Retry</Button>
      </div>
    );
  }
  if (state === "loading") {
    return (
      <p data-testid="media-loading" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading {label.toLowerCase()}...
      </p>
    );
  }
  if (state === "ready" && url) {
    if (media.kind === "image" || media.kind === "sticker") {
      return (
        <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL of an authenticated download; next/image cannot optimise it */}
          <img data-testid="media-image" src={url} alt={media.filename ?? "Image"} className="max-h-72 max-w-full rounded-md border object-contain" />
        </a>
      );
    }
    if (media.kind === "audio") return <audio data-testid="media-audio" controls src={url} className="max-w-full" onClick={(e) => e.stopPropagation()} />;
    if (media.kind === "video") return <video data-testid="media-video" controls src={url} className="max-h-72 max-w-full rounded-md" onClick={(e) => e.stopPropagation()} />;
    return (
      <a data-testid="media-download" href={url} download={media.filename ?? "file"} className="flex items-center gap-1.5 text-sm underline" onClick={(e) => e.stopPropagation()}>
        <FileText className="size-4 shrink-0" /> {label}
      </a>
    );
  }
  // idle: documents / audio / video wait for a click.
  return (
    <Button data-testid="media-load" type="button" size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onLoad(); }}>
      <Paperclip className="size-4" /> {media.kind === "document" ? `Open ${label}` : `Load ${label.toLowerCase()}`}
    </Button>
  );
}

export function MessageMedia({ messageId, media }: { messageId: string; media: MessageMediaInfo }) {
  const [requested, setRequested] = useState(AUTO_LOAD.has(media.kind));
  const enabled = requested && media.kind !== "unknown";
  const query = useQuery({
    queryKey: ["whatsapp-message-media", messageId],
    queryFn: () => whatsappHistoryApi.getMedia(messageId),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: (count, error) => !(axios.isAxiosError(error) && error.response && error.response.status < 500) && count < 1,
  });
  const url = useMemo(() => (query.data ? URL.createObjectURL(query.data) : null), [query.data]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const status = axios.isAxiosError(query.error) ? query.error.response?.status : undefined;
  const state: MediaState = !enabled ? "idle" : query.isError ? (status === 404 ? "expired" : "error") : query.data && url ? "ready" : "loading";
  return (
    <div className="mb-1" data-testid="message-media">
      <MediaFrame media={media} state={state} url={url} onLoad={() => (query.isError ? void query.refetch() : setRequested(true))} />
    </div>
  );
}
