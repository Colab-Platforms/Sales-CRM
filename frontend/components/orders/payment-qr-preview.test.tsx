// Run with: ../backend/node_modules/.bin/tsx --test components/orders/payment-qr-preview.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaFrame } from "@/components/whatsapp/conversation/message-media";
import { qrViewState } from "./payment-qr-preview";

const qr = { kind: "image" as const, mimeType: "image/png", filename: "payment-qr-CRM-1.png" };
const frame = (state: Parameters<typeof qrViewState>[0] extends never ? never : "idle" | "loading" | "ready" | "expired" | "error", url: string | null = null) => renderToStaticMarkup(<MediaFrame media={qr} state={state} url={url} onLoad={() => {}} />);

describe("the payment QR in the CRM (conversation message and order page)", () => {
  it("a loaded QR renders inline from a blob URL (never a provider URL or a Meta token), as a link to the full-size image", () => {
    const h = frame("ready", "blob:http://localhost/qr1");
    assert.match(h, /data-testid="media-image"/);
    assert.match(h, /src="blob:http:\/\/localhost\/qr1"/);
    assert.match(h, /alt="payment-qr-CRM-1\.png"/);
    assert.match(h, /<a [^>]*href="blob:/);
    assert.ok(!/graph\.facebook|access_token|Bearer/i.test(h));
  });
  it("shows a loading state while it loads and a useful, retryable error when it cannot be loaded", () => {
    assert.match(frame("loading"), /media-loading/);
    const e = frame("error");
    assert.match(e, /Could not load payment-qr-CRM-1\.png/i);
    assert.match(e, /Retry/);
  });
  it("an unavailable QR (no longer a Cashfree link / not found) is explained, not a broken image", () => {
    const h = frame("expired");
    assert.match(h, /no longer available/);
    assert.ok(!h.includes("<img"));
  });
  it("order-page state machine: nothing is requested until 'View QR'; 404 = unavailable, other failures = retryable error, data = ready", () => {
    assert.equal(qrViewState({ requested: false, isError: false, hasImage: false }), "idle");
    assert.equal(qrViewState({ requested: true, isError: false, hasImage: false }), "loading");
    assert.equal(qrViewState({ requested: true, isError: false, hasImage: true }), "ready");
    assert.equal(qrViewState({ requested: true, isError: true, status: 404, hasImage: false }), "expired");
    assert.equal(qrViewState({ requested: true, isError: true, status: 502, hasImage: false }), "error");
    assert.equal(qrViewState({ requested: true, isError: true, hasImage: false }), "error");
  });
});
