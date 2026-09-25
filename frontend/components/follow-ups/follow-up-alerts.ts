// Browser-side alert helpers for follow-up reminders. Everything here is best-effort: a blocked
// permission, no audio device or private-mode storage just means that one channel stays quiet.

export type DesktopAlertPermission = NotificationPermission | "unsupported";

export function desktopAlertPermission(): DesktopAlertPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function requestDesktopAlerts(): Promise<DesktopAlertPermission> {
  if (desktopAlertPermission() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return desktopAlertPermission();
  }
}

/** Shows an OS notification when allowed; clicking it brings the CRM tab to the front. */
export function desktopNotify(title: string, body: string, tag: string, sticky = false): void {
  if (desktopAlertPermission() !== "granted") return;
  try {
    const notification = new Notification(title, { body, tag, requireInteraction: sticky });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app toast still shows.
  }
}

/** A short two-tone chime, repeated `times` times. */
export function playChime(times = 1): void {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    let t = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      for (const freq of [880, 1175]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.2);
        t += 0.2;
      }
      t += 0.25;
    }
    setTimeout(() => void ctx.close(), (t - ctx.currentTime) * 1000 + 200);
  } catch {
    // Audio blocked until the user interacts with the page; the visual alerts still fire.
  }
}

/** A set of strings kept in sessionStorage, so a page refresh doesn't re-fire the same alert. */
export function loadSessionSet(key: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveSessionSet(key: string, set: Set<string>): void {
  try {
    // Only the most recent entries matter; keep the list from growing for a long-lived tab.
    sessionStorage.setItem(key, JSON.stringify([...set].slice(-200)));
  } catch {
    // Storage unavailable (private mode / blocked) - alerts may repeat after a refresh, nothing worse.
  }
}
