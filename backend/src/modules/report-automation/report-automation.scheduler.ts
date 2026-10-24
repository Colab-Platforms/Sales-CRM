import { logger } from "@/utils/logger.js";
import ReportAutomationService from "./report-automation.service.js";

// Same in-process interval convention as whatsapp.campaign.scheduler.ts / whatsapp.automation.scheduler.ts (this codebase has no queue system). It is safe in that form because nothing depends on the
// timer staying alive: every tick re-reads the database, a day's report is owned by a unique row, and a tick after a restart, a deploy or a sleep simply catches up (the day stays "due" until it ends).
// DEPLOYMENT NOTE: if the host puts the web service to sleep (e.g. a free Render instance), no timer runs while it sleeps - the report is then sent on the first tick after it wakes that same local day.
// A host that never sleeps (or an external ping to any API route every few minutes) is needed for an on-the-minute send.
const TICK_MS = 60_000;
let running = false;

export async function reportAutomationTick(service: ReportAutomationService = new ReportAutomationService()): Promise<void> {
  if (running) return; // never overlap two ticks of this process
  running = true;
  try {
    await service.runDue("scheduler");
  } catch (error) {
    logger.error("Report automation tick failed", error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
}

export function startReportAutomationScheduler(): NodeJS.Timeout {
  const service = new ReportAutomationService();
  void reportAutomationTick(service); // catch up immediately after a start / restart
  const timer = setInterval(() => void reportAutomationTick(service), TICK_MS);
  timer.unref?.();
  return timer;
}
