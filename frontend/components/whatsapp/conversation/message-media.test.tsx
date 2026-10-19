// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/conversation/message-media.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MediaFrame, MessageMedia, type MediaState } from "./message-media";
import type { MessageMediaInfo } from "@/lib/api-client/types/whatsapp-history.types";

const img: MessageMediaInfo = { kind: "image", mimeType: "image/jpeg", filename: null };
const frame = (media: MessageMediaInfo, state: MediaState, url: string | null = null) => renderToStaticMarkup(<MediaFrame media={media} state={state} url={url} onLoad={() => {}} />);

describe("customer file in a conversation", () => {
  it("a loaded image renders as an image from a blob URL (never a provider URL)", () => {
    const h = frame(img, "ready", "blob:http://localhost/abc");
    assert.match(h, /data-testid="media-image"/);
    assert.match(h, /src="blob:http:\/\/localhost\/abc"/);
  });
  it("shows a loading state, an expired state and a retryable error", () => {
    assert.match(frame(img, "loading"), /media-loading/);
    assert.match(frame(img, "expired"), /no longer available from WhatsApp/);
    const e = frame(img, "error");
    assert.match(e, /Could not load image/);
    assert.match(e, /Retry/);
  });
  it("an image with no recorded details says it cannot be shown - no broken image", () => {
    const h = frame({ kind: "unknown", mimeType: null, filename: null }, "idle");
    assert.match(h, /cannot be shown here/);
    assert.ok(!h.includes("<img"));
  });
  it("documents and audio wait for a click; a loaded document is a download link with its file name", () => {
    const doc: MessageMediaInfo = { kind: "document", mimeType: "application/pdf", filename: "slip.pdf" };
    assert.match(frame(doc, "idle"), /Open slip\.pdf/);
    const h = frame(doc, "ready", "blob:x");
    assert.match(h, /data-testid="media-download"/);
    assert.match(h, /download="slip\.pdf"/);
    assert.match(frame({ kind: "audio", mimeType: "audio/ogg", filename: null }, "ready", "blob:x"), /<audio/);
  });
  it("MessageMedia renders without crashing before the download finishes (images start loading, others wait)", () => {
    const wrap = (m: MessageMediaInfo) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><MessageMedia messageId="m1" media={m} /></QueryClientProvider>);
    assert.match(wrap(img), /media-loading/);
    assert.match(wrap({ kind: "document", mimeType: null, filename: null }), /media-load/);
  });
});
