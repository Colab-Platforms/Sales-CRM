import { CheckCircle2, Clock, PhoneMissed, PhoneOff, Voicemail, XCircle } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import type { CallSummary } from "@/lib/api-client/types/call-history.types";
import { formatTalkTime, inboundBuckets, outboundBuckets } from "./ivr-status-buckets";

export function IvrInboundSummaryCards({ summary, isLoading }: { summary: CallSummary | null; isLoading: boolean }) {
  const buckets = inboundBuckets(summary?.byStatus ?? []);
  const value = (n: number) => (isLoading ? "—" : n);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Calls" value={isLoading ? "—" : (summary?.total ?? 0)} icon={Voicemail} tone="primary" />
      <StatCard label="Answered" value={value(buckets.answered)} icon={CheckCircle2} tone="emerald" />
      {/* Missed and Abandoned are the same number - see ivr-status-buckets.ts for why they can't be told apart. */}
      <StatCard label="Missed / Abandoned" value={value(buckets.missedOrAbandoned)} hint="No answer, incl. abandoned in IVR" icon={PhoneMissed} tone="amber" />
      <StatCard label="Busy" value={value(buckets.busy)} icon={PhoneOff} tone="default" />
      <StatCard label="Total Talk Time" value={isLoading ? "—" : formatTalkTime(summary?.totalTalkTimeSeconds ?? 0)} icon={Clock} tone="teal" />
    </div>
  );
}

export function IvrOutboundSummaryCards({ summary, isLoading }: { summary: CallSummary | null; isLoading: boolean }) {
  const buckets = outboundBuckets(summary?.byStatus ?? []);
  const value = (n: number) => (isLoading ? "—" : n);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Calls" value={isLoading ? "—" : (summary?.total ?? 0)} icon={Voicemail} tone="primary" />
      <StatCard label="Answered" value={value(buckets.answered)} icon={CheckCircle2} tone="emerald" />
      <StatCard label="No Answer" value={value(buckets.noAnswer)} icon={PhoneMissed} tone="amber" />
      <StatCard label="Busy" value={value(buckets.busy)} icon={PhoneOff} tone="default" />
      <StatCard label="Failed" value={value(buckets.failed)} icon={XCircle} tone="default" />
      <StatCard label="Total Talk Time" value={isLoading ? "—" : formatTalkTime(summary?.totalTalkTimeSeconds ?? 0)} icon={Clock} tone="teal" />
    </div>
  );
}
