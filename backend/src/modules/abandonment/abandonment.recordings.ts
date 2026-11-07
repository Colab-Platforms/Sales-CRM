import { Buffer } from "node:buffer";
import zlib from "node:zlib";
import { prisma } from "@/lib/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { dayBounds } from "../attendance/attendance.calc.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { abandonmentLeadScope, canAccessRecordings } from "./abandonment.filters.js";

// Admin / manager-only access to the call recordings of abandoned leads: one recording (download) and many at once (ZIP).
// Nothing here stores or creates recordings - it reads the CallRecording rows the calling integration already writes and
// fetches each recording from the URL that integration saved.

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_FILE_MB = 25;
const MAX_REDIRECTS = 3;

// ---------- file names ----------

/** A filename-safe version of free text: letters, digits, dot, dash, underscore only. */
export function safeFilePart(text: string | null | undefined, fallback = "unknown"): string {
  const cleaned = (text ?? "").normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^[_.-]+|[_.-]+$/g, "").slice(0, 40);
  return cleaned || fallback;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-05_1417" in the reporting timezone (IST), the same calendar the rest of the abandoned-leads screens use. */
export function recordingStamp(at: Date, tzOffsetMinutes: number = REPORT_TZ_OFFSET_MINUTES): string {
  const local = new Date(at.getTime() + tzOffsetMinutes * 60_000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}_${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}`;
}

const KNOWN_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "amr", "webm", "mp4"]);

export function recordingExtension(url: string, contentType?: string | null): string {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (ext && KNOWN_EXTENSIONS.has(ext)) return ext;
  } catch {
    // fall through to the content type
  }
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("wav")) return "wav";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("aac")) return "aac";
  return "mp3";
}

/** e.g. "LEAD-AB12_Rahul_Sharma_2026-11-05_1417_3f9a1c2e.mp3": lead number, customer, recording date/time, and a short call id that keeps two calls in the same minute apart. */
export function recordingFileName(input: { leadNumber: string; customerName: string; at: Date; callId: string; extension: string }): string {
  return `${safeFilePart(input.leadNumber, "lead")}_${safeFilePart(input.customerName, "customer")}_${recordingStamp(input.at)}_${input.callId.replace(/-/g, "").slice(0, 8)}.${input.extension}`;
}

// ---------- fetching a recording ----------

/** Hosts a recording may be fetched from: RECORDING_ALLOWED_HOSTS (comma list; "example.com" = that host and its subdomains, "*.example.com" = subdomains only) plus the call provider's own host. */
export function allowedRecordingHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts = new Set<string>(["callerdesk.io"]);
  try {
    if (env.CALLERDESK_BASE_URL) hosts.add(new URL(env.CALLERDESK_BASE_URL).hostname.toLowerCase().replace(/^app\./, ""));
  } catch {
    // an unparsable base URL adds nothing
  }
  for (const raw of (env.RECORDING_ALLOWED_HOSTS ?? "").split(",")) {
    const host = raw.trim().toLowerCase();
    if (host && host !== "*") hosts.add(host);
  }
  return [...hosts];
}

export function isAllowedRecordingHost(hostname: string, allowed: string[] = allowedRecordingHosts()): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry || host.endsWith(`.${entry}`)));
}

/** Thrown for a failure that retrying cannot fix (blocked host, 4xx answer, too large). */
export class PermanentRecordingError extends Error {}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Only an https URL to an approved, public host is ever fetched server-side. */
export function assertFetchableRecordingUrl(raw: string, allowed: string[] = allowedRecordingHosts()): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PermanentRecordingError("invalid recording URL");
  }
  if (url.protocol !== "https:") throw new PermanentRecordingError("recording URL is not https");
  if (isPrivateHost(url.hostname)) throw new PermanentRecordingError("recording URL host is not allowed");
  if (!isAllowedRecordingHost(url.hostname, allowed)) throw new PermanentRecordingError(`recording host not approved: ${url.hostname}`);
  return url;
}

export type RecordingFetcher = (url: string) => Promise<{ data: Buffer; contentType: string | null }>;

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** One attempt: https + approved host only, manual redirects (each re-validated), a timeout, and a hard size cap enforced WHILE reading (never trusting content-length alone). */
export const fetchRecordingOnce: RecordingFetcher = async (rawUrl) => {
  const maxBytes = envNumber("RECORDING_EXPORT_MAX_FILE_MB", FETCH_MAX_FILE_MB) * 1024 * 1024;
  let url = assertFetchableRecordingUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new PermanentRecordingError("redirect without a location");
      url = assertFetchableRecordingUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new PermanentRecordingError(`provider answered ${response.status}`);
    if (!response.ok) throw new Error(`provider answered ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new PermanentRecordingError("recording is too large");
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PermanentRecordingError("recording is too large");
      }
      chunks.push(Buffer.from(value));
    }
    if (total === 0) throw new PermanentRecordingError("recording is empty");
    return { data: Buffer.concat(chunks), contentType: response.headers.get("content-type") };
  }
  throw new PermanentRecordingError("too many redirects");
};

/** Retries a transient failure (timeout, network, 5xx, 408/429) with backoff; a permanent one (blocked host, other 4xx, too large) fails at once. */
export function withRetries(fetchOnce: RecordingFetcher, options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}): RecordingFetcher {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (url) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fetchOnce(url);
      } catch (error) {
        lastError = error;
        if (error instanceof PermanentRecordingError || attempt === attempts) break;
        await sleep(500 * 3 ** (attempt - 1));
      }
    }
    throw lastError;
  };
}

export const fetchRecordingFile: RecordingFetcher = withRetries(fetchRecordingOnce);

// ---------- ZIP pieces (stored, no compression: call audio is already compressed) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Js(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Native (zlib.crc32, Node 22.2+) when available: an export checksums hundreds of MB of audio, and a byte-at-a-time JS loop would hold the event loop - and every web request - for seconds.
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;
export const crc32: (data: Uint8Array) => number = nativeCrc32 ? (data) => nativeCrc32(data) >>> 0 : crc32Js;

export interface ZipEntryInfo {
  name: string;
  crc: number;
  size: number;
  localOffset: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

/** The local header (with the name) of one stored entry; the entry's data follows it directly. */
export function zipLocalHeader(name: string, data: Uint8Array, now: Date): { header: Buffer; crc: number } {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const { time, date } = dosDateTime(now);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  return { header: Buffer.concat([local, nameBuf]), crc };
}

/** The central directory + end record for entries already written; `directoryOffset` is where the directory itself starts. */
export function zipCentralDirectory(entries: ZipEntryInfo[], directoryOffset: number, now: Date): Buffer {
  const { time, date } = dosDateTime(now);
  const parts: Buffer[] = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(e.crc, 16);
    entry.writeUInt32LE(e.size, 20);
    entry.writeUInt32LE(e.size, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(e.localOffset, 42);
    parts.push(entry, nameBuf);
  }
  const directory = Buffer.concat(parts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([directory, end]);
}

/** Small in-memory-friendly writer used by tests and one-off archives. */
export class ZipWriter {
  private offset = 0;
  private readonly entries: ZipEntryInfo[] = [];
  constructor(private readonly write: (chunk: Buffer) => void | Promise<void>, private readonly now: Date = new Date()) {}

  async add(name: string, data: Buffer): Promise<void> {
    const { header, crc } = zipLocalHeader(name, data, this.now);
    this.entries.push({ name, crc, size: data.length, localOffset: this.offset });
    await this.write(header);
    await this.write(data);
    this.offset += header.length + data.length;
  }

  async finish(): Promise<void> {
    await this.write(zipCentralDirectory(this.entries, this.offset, this.now));
  }
}

// ---------- the service ----------

export interface RecordingRow {
  callId: string;
  recordingUrl: string | null;
  expiresAt: Date | null;
  at: Date;
  leadNumber: string;
  customerName: string;
}

export interface RecordingRange {
  from: string; // YYYY-MM-DD (IST)
  to: string; // YYYY-MM-DD (IST), inclusive
}

export interface RecordingSummary {
  from: string;
  to: string;
  /** Calls in the range that have a recording entry. */
  total: number;
  /** Recordings with a usable link that the ZIP will try to include (duplicates already removed). */
  available: number;
  /** Recordings that exist as an entry but have no usable link (missing, expired, not https). */
  unavailable: number;
  /** The same recording attached to more than one call: counted once. */
  duplicates: number;
}

/** Why a recording cannot be downloaded, or null when it can. */
export function unavailableReason(row: Pick<RecordingRow, "recordingUrl" | "expiresAt">, now: Date = new Date()): string | null {
  if (!row.recordingUrl || !row.recordingUrl.trim()) return "no recording link";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "recording link expired";
  try {
    assertFetchableRecordingUrl(row.recordingUrl);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 150) : "recording link not allowed";
  }
}

export function isUsableRecording(row: Pick<RecordingRow, "recordingUrl" | "expiresAt">, now: Date = new Date()): boolean {
  if (!row.recordingUrl || !row.recordingUrl.trim()) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return false;
  try {
    assertFetchableRecordingUrl(row.recordingUrl);
    return true;
  } catch {
    return false;
  }
}

/** Splits rows into the ones to download (one per distinct recording URL, oldest first) and counts of those left out. */
export function planRecordings(rows: RecordingRow[], now: Date = new Date()): { usable: RecordingRow[]; unavailable: RecordingRow[]; duplicates: number } {
  const usable: RecordingRow[] = [];
  const unavailable: RecordingRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || a.callId.localeCompare(b.callId))) {
    if (!isUsableRecording(row, now)) {
      unavailable.push(row);
      continue;
    }
    const key = row.recordingUrl!.trim();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    usable.push(row);
  }
  return { usable, unavailable, duplicates };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Both ends are calendar days in IST, `to` inclusive. */
export function recordingRangeBounds(range: RecordingRange): { gte: Date; lt: Date } {
  if (!DAY_RE.test(range.from) || !DAY_RE.test(range.to)) throw new ApiError("from and to must be dates (YYYY-MM-DD)", STATUS_CODES.BAD_REQUEST);
  if (range.from > range.to) throw new ApiError("from must not be after to", STATUS_CODES.BAD_REQUEST);
  const from = dayBounds(range.from, REPORT_TZ_OFFSET_MINUTES);
  const to = dayBounds(range.to, REPORT_TZ_OFFSET_MINUTES);
  if (Number.isNaN(from.from.getTime()) || Number.isNaN(to.to.getTime())) throw new ApiError("from and to must be valid dates", STATUS_CODES.BAD_REQUEST);
  return { gte: from.from, lt: to.to };
}

export class AbandonmentRecordingsService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly fetchFile: RecordingFetcher = fetchRecordingFile,
  ) {}

  private assertAllowed(user: AuthUser): void {
    if (!canAccessRecordings(user.role)) throw new ApiError("Only admins and managers can access call recordings", STATUS_CODES.FORBIDDEN);
  }

  /**
   * Calls (with a recording entry) to leads the user may see that have an abandoned checkout. Without `page` everything matching is returned (single lookups); with it, one keyset page
   * (ordered by id, `take` rows after `afterId`) so a year of data is read in bounded chunks and never as one result.
   */
  async rowsFor(user: AuthUser, where: Record<string, unknown>, page?: { afterId?: string; take: number }): Promise<RecordingRow[]> {
    const leadScope = abandonmentLeadScope(user);
    const calls = await this.db.call.findMany({
      where: { ...where, ...(page?.afterId ? { id: { gt: page.afterId } } : {}), recording: { isNot: null }, lead: { AND: [leadScope, { abandonments: { some: {} } }] } },
      select: {
        id: true,
        startedAt: true,
        createdAt: true,
        recording: { select: { recordingUrl: true, expiresAt: true } },
        lead: { select: { leadNumber: true, firstName: true, lastName: true } },
      },
      orderBy: page ? [{ id: "asc" }] : [{ createdAt: "asc" }, { id: "asc" }],
      ...(page ? { take: page.take } : {}),
    });
    return calls.map((c) => ({
      callId: c.id,
      recordingUrl: c.recording?.recordingUrl ?? null,
      expiresAt: c.recording?.expiresAt ?? null,
      at: c.startedAt ?? c.createdAt,
      leadNumber: c.lead?.leadNumber ?? "lead",
      customerName: [c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(" "),
    }));
  }

  rangeWhere(range: RecordingRange) {
    const { gte, lt } = recordingRangeBounds(range);
    // The call's own start time (falling back to when the row was created, for calls that never got a start time).
    return { OR: [{ startedAt: { gte, lt } }, { startedAt: null, createdAt: { gte, lt } }] };
  }

  /**
   * How many recordings a date range holds, counted by the database (one aggregate query - never every row loaded into the server), so it stays fast for a year of data.
   * Same rules as the export: usable = has a link, not expired, https on an approved host; duplicates = the same link used by more than one call.
   */
  async summary(user: AuthUser, range: RecordingRange): Promise<RecordingSummary> {
    this.assertAllowed(user);
    const { gte, lt } = recordingRangeBounds(range);
    const host = Prisma.sql`lower(substring(r.recording_url from '^https://([^/:?#@]+)'))`;
    const approved = allowedRecordingHosts()
      .map((h) => h.replace(/[^a-z0-9.*-]/g, ""))
      .filter(Boolean)
      .map((h) => (h.startsWith("*.") ? Prisma.sql`${host} LIKE ${"%." + h.slice(2)}` : Prisma.sql`(${host} = ${h} OR ${host} LIKE ${"%." + h})`));
    const scope = user.role === Role.MANAGER ? Prisma.sql`AND l.assigned_manager_id = ${user.id}::uuid` : Prisma.empty;
    const rows = await this.db.$queryRaw<{ total: bigint; usable: bigint; distinct_urls: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE t.ok) AS usable,
             count(DISTINCT t.url) FILTER (WHERE t.ok) AS distinct_urls
      FROM (
        SELECT r.recording_url AS url,
               (r.recording_url IS NOT NULL AND btrim(r.recording_url) <> '' AND (r.expires_at IS NULL OR r.expires_at > now())
                AND ${approved.length > 0 ? Prisma.join(approved, " OR ") : Prisma.sql`false`}) AS ok
        FROM calls c
        JOIN call_recordings r ON r.call_id = c.id
        JOIN leads l ON l.id = c.lead_id
        WHERE ((c.started_at >= ${gte}::timestamp AND c.started_at < ${lt}::timestamp) OR (c.started_at IS NULL AND c.created_at >= ${gte}::timestamp AND c.created_at < ${lt}::timestamp))
          AND EXISTS (SELECT 1 FROM abandonments a WHERE a.lead_id = l.id)
          ${scope}
      ) t`);
    const total = Number(rows[0]?.total ?? 0);
    const usable = Number(rows[0]?.usable ?? 0);
    const distinct = Number(rows[0]?.distinct_urls ?? 0);
    return { from: range.from, to: range.to, total, available: distinct, unavailable: total - usable, duplicates: usable - distinct };
  }

  /** One recording, for download. The same permission and lead-scope rules as the list. */
  async single(user: AuthUser, callId: string): Promise<{ data: Buffer; contentType: string; fileName: string }> {
    this.assertAllowed(user);
    const [row] = await this.rowsFor(user, { id: callId });
    if (!row) throw new ApiError("Recording not found", STATUS_CODES.NOT_FOUND);
    if (!isUsableRecording(row)) throw new ApiError("This recording is not available", STATUS_CODES.NOT_FOUND);
    let file;
    try {
      file = await this.fetchFile(row.recordingUrl!);
    } catch {
      throw new ApiError("The recording could not be fetched from the call provider", 502);
    }
    const extension = recordingExtension(row.recordingUrl!, file.contentType);
    return { data: file.data, contentType: file.contentType ?? "application/octet-stream", fileName: recordingFileName({ ...row, extension }) };
  }
}
