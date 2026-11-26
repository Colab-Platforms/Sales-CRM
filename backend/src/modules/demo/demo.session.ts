// Demo sessions. Isolation starts here:
//   - A demo token is signed with a key DERIVED from JWT_SECRET (HMAC of a fixed label), not with JWT_SECRET itself, and carries its own audience. The real
//     requireAuth/verifyToken therefore cannot validate a demo token, and the demo guard cannot validate a real one: neither kind of session can reach the other
//     API, whatever the browser sends. No secret is stored in source; the key exists only in memory.
//   - A session owns its own in-memory copy of the fictional world, so even the few demo writes that are allowed change nothing outside that session.
//   - SINGLE-INSTANCE REQUIREMENT: sessions, their data copies and the start-rate brake live in this process's memory only. Run the demo on ONE backend instance: with several
//     instances (or after a restart/deploy) a request can land where the session is unknown, which then starts a fresh copy of the world, so edits made earlier in the
//     session are lost (reads stay valid, because the signed token carries the session id and role). Nothing is persisted and nothing real is involved either way.
//   - Entry is OFF unless DEMO_MODE_ENABLED=true, and can be protected with an access code (DEMO_ACCESS_CODE) that lives only in the environment.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { buildDemoWorld, type DemoRole, type DemoUser, type DemoWorld, DEMO_ROLES } from "./demo.data.js";

export const DEMO_AUDIENCE = "crm-demo-session";
export const DEMO_SESSION_TTL_MS = 8 * 3_600_000;
const MAX_SESSIONS = 200;
const MAX_ENTRIES_PER_MINUTE = 30;

export interface DemoClaims {
  sub: string;
  sid: string;
  role: DemoRole;
  demo: true;
}

export interface DemoSessionState {
  sid: string;
  world: DemoWorld;
  createdAt: number;
}

type Env = Record<string, string | undefined>;

export const isDemoEnabled = (env: Env = process.env): boolean => env.DEMO_MODE_ENABLED === "true";

/** The signing key for demo tokens: derived, never equal to JWT_SECRET, never logged or stored. */
function demoKey(env: Env = process.env): string {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return createHmac("sha256", secret).update("sales-crm:demo-session:v1").digest("hex");
}

export function accessCodeMatches(given: unknown, env: Env = process.env): boolean {
  const expected = env.DEMO_ACCESS_CODE;
  if (!expected) return true; // no code configured: the entry page alone is the gate
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const personaFor = (world: DemoWorld, role: DemoRole): DemoUser =>
  role === "ADMIN" ? world.users.find((u) => u.role === "ADMIN")! : role === "MANAGER" ? world.users.find((u) => u.role === "MANAGER")! : world.users.find((u) => u.role === "SALESPERSON")!;

export function signDemoToken(claims: DemoClaims, env: Env = process.env): string {
  return jwt.sign({ ...claims }, demoKey(env), { audience: DEMO_AUDIENCE, expiresIn: Math.floor(DEMO_SESSION_TTL_MS / 1000) });
}

export function verifyDemoToken(token: string, env: Env = process.env): DemoClaims | null {
  try {
    const p = jwt.verify(token, demoKey(env), { audience: DEMO_AUDIENCE }) as Partial<DemoClaims>;
    if (p.demo !== true || typeof p.sid !== "string" || typeof p.sub !== "string" || !DEMO_ROLES.includes(p.role as DemoRole)) return null;
    return { sub: p.sub, sid: p.sid, role: p.role as DemoRole, demo: true };
  } catch {
    return null;
  }
}

const sessions = new Map<string, DemoSessionState>();
const entries: number[] = [];

/** Starts a session, or null when too many sessions are being started (a simple per-process brake on a public entry point). */
export function startSession(now = Date.now()): DemoSessionState | null {
  while (entries.length && entries[0]! < now - 60_000) entries.shift();
  if (entries.length >= MAX_ENTRIES_PER_MINUTE) return null;
  entries.push(now);
  for (const [sid, s] of sessions) if (now - s.createdAt > DEMO_SESSION_TTL_MS) sessions.delete(sid);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  const sid = randomBytes(12).toString("hex");
  const state = { sid, world: buildDemoWorld(now), createdAt: now };
  sessions.set(sid, state);
  return state;
}

/** The session behind a valid token. A restarted server (or an expired session) simply starts a fresh world for the same session id, so a reload never errors. */
export function sessionFor(claims: DemoClaims, now = Date.now()): DemoSessionState {
  let s = sessions.get(claims.sid);
  if (!s) {
    s = { sid: claims.sid, world: buildDemoWorld(now), createdAt: now };
    sessions.set(claims.sid, s);
  }
  return s;
}

export const clearDemoSessions = (): void => {
  sessions.clear();
  entries.length = 0;
};
