import type { Response } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { DISCONNECT_GRACE_MS, HEARTBEAT_TIMEOUT_MS, PING_INTERVAL_MS } from "./attendance.constants.js";
import type { StatusEvent } from "./attendance.types.js";

interface TeamSubscriber {
  userId: string;
  role: Role;
}

// In-memory presence for the single backend instance: which salesperson browsers have a live stream
// open, and which managers/admins are watching the team board. The database (WorkSession) stays the
// source of truth - this only answers "is a browser connected right now?". If the backend ever runs on
// more than one instance, this is the one file to swap for a shared bus (e.g. Postgres LISTEN/NOTIFY).
class PresenceRegistry {
  readonly bootedAt = Date.now();
  // Set by the service: a salesperson stayed disconnected for the whole grace period.
  onGraceExpired: (userId: string) => void = () => {};

  private connections = new Map<string, Set<Response>>();
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private lastBeatAt = new Map<string, number>();
  private teamSubscribers = new Map<Response, TeamSubscriber>();
  private pingTimer: NodeJS.Timeout | null = null;

  isConnected(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }

  // A heartbeat (or a freshly opened stream) from the browser, proving it is really there.
  touch(userId: string): void {
    this.lastBeatAt.set(userId, Date.now());
  }

  // Connected AND recently heard from. An open socket alone can be a zombie (sleeping laptop).
  isAlive(userId: string): boolean {
    return this.isConnected(userId) && Date.now() - (this.lastBeatAt.get(userId) ?? 0) < HEARTBEAT_TIMEOUT_MS;
  }

  aliveUserIds(): string[] {
    return [...this.connections.keys()].filter((id) => this.isAlive(id));
  }

  // True while the server has been up less than the grace period: clients are still reconnecting after
  // a deploy/restart, so nobody should be flagged as gone yet.
  inBootGrace(): boolean {
    return Date.now() - this.bootedAt < DISCONNECT_GRACE_MS;
  }

  openUserStream(userId: string, res: Response): void {
    const pending = this.graceTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.graceTimers.delete(userId);
    }
    const set = this.connections.get(userId) ?? new Set<Response>();
    set.add(res);
    this.connections.set(userId, set);
    this.touch(userId);
  }

  // Counted per user so several tabs behave: only the last one closing starts the grace timer.
  closeUserStream(userId: string, res: Response): void {
    const set = this.connections.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size > 0) return;

    this.connections.delete(userId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(userId);
      if (!this.isConnected(userId)) this.onGraceExpired(userId);
    }, DISCONNECT_GRACE_MS);
    this.graceTimers.set(userId, timer);
  }

  addTeamSubscriber(res: Response, subscriber: TeamSubscriber): void {
    this.teamSubscribers.set(res, subscriber);
  }

  removeTeamSubscriber(res: Response): void {
    this.teamSubscribers.delete(res);
  }

  sendToUser(userId: string, event: StatusEvent): void {
    for (const res of this.connections.get(userId) ?? []) this.write(res, event);
  }

  // Admins see every salesperson; a manager only sees their own direct reports.
  broadcastToTeam(event: StatusEvent): void {
    for (const [res, sub] of this.teamSubscribers) {
      if (sub.role === Role.ADMIN || event.managerId === sub.userId) this.write(res, event);
    }
  }

  startPings(): void {
    if (this.pingTimer) return;
    // A write to a dead socket errors or backs up, and that closes the response - which is how we notice.
    this.pingTimer = setInterval(() => {
      for (const set of this.connections.values()) for (const res of set) this.writeRaw(res, ": ping\n\n");
      for (const res of this.teamSubscribers.keys()) this.writeRaw(res, ": ping\n\n");
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private write(res: Response, event: StatusEvent): void {
    this.writeRaw(res, `data: ${JSON.stringify(event)}\n\n`);
  }

  private writeRaw(res: Response, chunk: string): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      // The close handler registered by the stream route cleans this connection up.
    }
  }
}

export const presence = new PresenceRegistry();
