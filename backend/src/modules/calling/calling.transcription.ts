import type { Job } from "pg-boss";
import { prisma } from "@/lib/prisma.js";
import { getQueue } from "@/lib/queue.js";
import { logger } from "@/utils/logger.js";
import { transcriptEventName, transcriptEvents } from "./calling.events.js";

// Background call transcription: enqueue is called from the CallerDesk webhook the moment a
// recording URL lands (calling.service.ts's handleCallWebhook), and returns immediately - the
// webhook response never waits on Deepgram. The actual transcription runs here, off the request
// path, via pg-boss (a real job queue on the same Postgres, not another setInterval poller).

const QUEUE_NAME = "transcribe-call";
const RETRY_LIMIT = 3; // must match the createQueue() call below - used to tell a final failure from one pg-boss will still retry

interface TranscribeCallJob {
  callId: string;
}

let queueReady: Promise<void> | null = null;

// Idempotent and cheap (an INSERT ... ON CONFLICT under the hood), but send()/work() both require
// the queue to already exist - called from both enqueue and worker startup so neither has to assume
// which one runs first.
async function ensureQueue(): Promise<void> {
  if (!queueReady) {
    queueReady = getQueue().then(async (boss) => {
      await boss.createQueue(QUEUE_NAME, { retryLimit: RETRY_LIMIT, retryBackoff: true });
    });
  }
  return queueReady;
}

export async function enqueueTranscription(callId: string): Promise<void> {
  try {
    await ensureQueue();
    const boss = await getQueue();
    await boss.send(QUEUE_NAME, { callId } satisfies TranscribeCallJob);
  } catch (error) {
    // Never let a queueing failure break the webhook it's called from - the recording is already
    // saved; a transcript is a nice-to-have that can be retried by re-running this later if needed.
    logger.error(`[transcription] failed to enqueue call=${callId}`, error);
  }
}

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  speaker?: number;
}

interface DeepgramResponse {
  results?: {
    channels?: {
      detected_language?: string;
      alternatives?: { transcript?: string; words?: DeepgramWord[] }[];
    }[];
  };
}

// Groups diarized words into speaker turns, labeled "Speaker 1", "Speaker 2" in order of first
// appearance. No Agent/Customer guess - Deepgram can't tell the two apart on mono phone audio.
// Null when there's only one speaker (nothing to separate) or no diarization data at all.
function buildDiarizedText(words: DeepgramWord[] | undefined): string | null {
  if (!words?.length) return null;

  const segments: { speaker: number; text: string }[] = [];
  for (const w of words) {
    const speaker = w.speaker ?? 0;
    const token = w.punctuated_word ?? w.word;
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) last.text += ` ${token}`;
    else segments.push({ speaker, text: token });
  }

  const speakerOrder = [...new Set(segments.map((s) => s.speaker))];
  if (speakerOrder.length < 2) return null; // one voice on the recording - nothing to attribute

  const label = (speaker: number): string => `Speaker ${speakerOrder.indexOf(speaker) + 1}`;

  return segments.map((s) => `${label(s.speaker)}: ${s.text}`).join("\n");
}

async function transcribeWithDeepgram(
  recordingUrl: string,
): Promise<{ text: string; diarizedText: string | null; language: string | null }> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");

  // detect_language: auto-identifies the single best-matching language for the whole recording from
  // Deepgram's supported list (not per-word code-switching across languages - no ASR vendor does
  // that reliably yet). diarize: separates speakers.
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true&punctuate=true&diarize=true&diarize_version=latest",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: recordingUrl }),
    },
  );

  if (!res.ok) {
    throw new Error(`Deepgram request failed (${res.status}): ${await res.text().catch(() => "")}`);
  }

  const body = (await res.json()) as DeepgramResponse;
  const channel = body?.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const text = typeof alternative?.transcript === "string" ? alternative.transcript : "";
  const language = typeof channel?.detected_language === "string" ? channel.detected_language : null;
  const diarizedText = buildDiarizedText(alternative?.words);
  return { text, diarizedText, language };
}

async function processJob(job: Job<TranscribeCallJob>): Promise<void> {
  const { callId } = job.data;
  const recording = await prisma.callRecording.findUnique({ where: { callId } });
  if (!recording?.recordingUrl) {
    logger.warn(`[transcription] call=${callId} has no recording to transcribe - skipping`);
    return;
  }

  await prisma.callTranscript.upsert({
    where: { callId },
    create: { callId, provider: "DEEPGRAM", status: "PROCESSING" },
    update: { status: "PROCESSING" },
  });

  try {
    const { text, diarizedText, language } = await transcribeWithDeepgram(recording.recordingUrl);
    const status = text ? "COMPLETED" : "EMPTY";
    await prisma.callTranscript.update({
      where: { callId },
      data: { transcriptText: text || null, diarizedText, language, status },
    });
    transcriptEvents.emit(transcriptEventName(callId), { callId, status, transcriptText: text || null });
  } catch (error) {
    logger.error(`[transcription] failed for call=${callId} (attempt ${job.retryCount + 1}/${RETRY_LIMIT + 1})`, error);
    // Only the last attempt is a real failure worth reporting - an earlier one is about to be
    // retried by pg-boss, and marking/pushing FAILED now would tell an open SSE stream to give up
    // right as a retry could still succeed.
    if (job.retryCount >= RETRY_LIMIT) {
      await prisma.callTranscript.update({ where: { callId }, data: { status: "FAILED" } });
      transcriptEvents.emit(transcriptEventName(callId), { callId, status: "FAILED", transcriptText: null });
    }
    throw error; // lets pg-boss retry the job
  }
}

export async function startCallTranscriptionWorker(): Promise<void> {
  await ensureQueue();
  const boss = await getQueue();
  await boss.work<TranscribeCallJob>(QUEUE_NAME, async (jobs) => {
    for (const job of jobs) {
      await processJob(job);
    }
  });
  logger.info("[transcription] worker registered");
}
