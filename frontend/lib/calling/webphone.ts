import type Plivo from "plivo-browser-sdk";

// Thin wrapper over the Plivo Browser SDK. The backend mints a short-lived JWT per call (POST .../web-call);
// we log in with it, then dial. The number actually rung is decided server-side from the Call row named by
// the X-PH-CallId header - `destination` is only what the SDK needs as a dial target.
//
// The SDK touches window/WebRTC at import time, so it is only ever loaded dynamically in the browser.

type PlivoClient = InstanceType<typeof Plivo>["client"];

export interface WebCallHandle {
  hangup: () => void;
  /** Flips mute and returns whether the call is now muted. */
  toggleMute: () => boolean;
}

export interface StartWebCallInput {
  token: string;
  tokenExpiresInSeconds: number;
  callId: string;
  destination: string;
  /** The browser leg ended (hangup, failure, or the remote side dropping). The backend webhook sets the final status. */
  onEnded: (reason?: string) => void;
  /** Something stopped the call before it started (login failed, mic blocked). */
  onError: (message: string) => void;
}

let sdk: Plivo | null = null;
let loggedInUntil = 0;

async function getClient(): Promise<PlivoClient> {
  if (!sdk) {
    const { default: PlivoSdk } = await import("plivo-browser-sdk");
    sdk = new PlivoSdk({
      debug: process.env.NEXT_PUBLIC_WEB_CALLING_DEBUG === "true" ? "DEBUG" : "ERROR",
      permOnClick: true,
      closeProtection: true,
      maxAverageBitrate: 48000,
    } as ConstructorParameters<typeof PlivoSdk>[0]);
  }
  return sdk.client;
}

function login(client: PlivoClient, token: string, expiresInSeconds: number): Promise<void> {
  // Re-use a live session; re-login a minute before the JWT would expire.
  if (Date.now() < loggedInUntil - 60_000) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      client.off("onLogin", onLogin);
      client.off("onLoginFailed", onFailed);
    };
    const onLogin = () => {
      cleanup();
      loggedInUntil = Date.now() + expiresInSeconds * 1000;
      resolve();
    };
    const onFailed = (reason?: unknown) => {
      cleanup();
      loggedInUntil = 0;
      reject(new Error(typeof reason === "string" ? reason : "Could not connect to the calling service."));
    };
    client.on("onLogin", onLogin);
    client.on("onLoginFailed", onFailed);
    client.loginWithAccessToken(token);
  });
}

function describe(reason: unknown): string {
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return "unknown reason";
  }
}

export async function startWebCall(input: StartWebCallInput): Promise<WebCallHandle> {
  let client: PlivoClient;
  try {
    client = await getClient();
    await login(client, input.token, input.tokenExpiresInSeconds);
  } catch (error) {
    input.onError(error instanceof Error ? error.message : "Could not start the browser call.");
    throw error;
  }

  let muted = false;
  let ended = false;

  const finish = (reason?: string) => {
    if (ended) return;
    ended = true;
    client.off("onCallTerminated", onTerminated);
    client.off("onCallFailed", onFailed);
    input.onEnded(reason);
  };
  const onTerminated = () => finish();
  const onPermission = (event: unknown) => console.info("[webphone] media permission", event);
  client.on("onMediaPermission", onPermission);
  const onFailed = (reason?: unknown) => {
    console.error("[webphone] call failed", reason);
    input.onError(`Call failed: ${describe(reason)}`);
    finish("failed");
  };

  client.on("onCallTerminated", onTerminated);
  client.on("onCallFailed", onFailed);

  client.call(input.destination, { "X-PH-CallId": input.callId });

  return {
    hangup: () => {
      client.hangup();
      finish();
    },
    toggleMute: () => {
      if (muted) client.unmute();
      else client.mute();
      muted = !muted;
      return muted;
    },
  };
}
