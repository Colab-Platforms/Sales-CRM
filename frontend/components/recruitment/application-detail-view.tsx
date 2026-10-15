"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Mail, Phone } from "lucide-react";
import { applicationQueryOptions } from "@/lib/api-client/queries/recruitment.queries";
import { useUpdateApplicationMutation } from "@/lib/api-client/mutations/recruitment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { RECRUITER_STATUSES, type Application, type ApplicationStatus } from "@/lib/api-client/types/recruitment.types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { ApplicationStatusBadge, applicationStatusClasses, applicationStatusLabel } from "./application-status-badge";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function WorkCard({ application }: { application: Application }) {
  const update = useUpdateApplicationMutation();
  // Starts empty while the application is still New/Assigned - the user picks the outcome.
  const [status, setStatus] = useState<ApplicationStatus | "">(RECRUITER_STATUSES.includes(application.status) ? application.status : "");
  const [notes, setNotes] = useState(application.notes ?? "");
  const dirty = (status !== "" && status !== application.status) || notes !== (application.notes ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Update status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Application status">
          {RECRUITER_STATUSES.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              aria-pressed={status === s}
              className={cn(status === s && cn("ring-2 ring-offset-1 ring-current", applicationStatusClasses(s)))}
              onClick={() => setStatus(s)}
            >
              {applicationStatusLabel(s)}
            </Button>
          ))}
        </div>
        <textarea
          aria-label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder="Notes about this candidate"
          className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <Button
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate(
              {
                id: application.id,
                payload: {
                  ...(status && status !== application.status ? { status } : {}),
                  ...(notes !== (application.notes ?? "") ? { notes } : {}),
                },
              },
              {
                onSuccess: () => toast.success("Saved."),
                onError: (e) => toast.error(getErrorMessage(e, "Failed to save.")),
              },
            )
          }
        >
          {update.isPending ? "Saving..." : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ApplicationDetailView({ applicationId }: { applicationId: string }) {
  const role = useAuthStore((s) => s.user?.role);
  const { data: application, isPending, error } = useQuery(applicationQueryOptions(applicationId));

  // HR/admin came from a job's applications; a recruiter came from their own queue.
  const backHref = role === "RECRUITER" || !application ? "/dashboard/applications" : `/dashboard/jobs/${application.jobId}`;
  const backLabel = role === "RECRUITER" || !application ? "My applications" : `Back to ${application.job.title}`;

  return (
    <div className="space-y-6">
      <Link href={backHref} className={buttonVariants({ variant: "ghost", size: "sm" }) + " w-fit"}>
        <ArrowLeft />
        {backLabel}
      </Link>

      {isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : error || !application ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Application not found.")}
        </div>
      ) : (
        <>
          <PageHeader
            title={application.name}
            description={`Applied for ${application.job.title}`}
            actions={<ApplicationStatusBadge status={application.status} />}
          />

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Applicant</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="flex items-center gap-2">
                  <Phone className="size-4 text-muted-foreground" />
                  {application.mobile}
                </p>
                <p className="flex items-center gap-2">
                  <Mail className="size-4 text-muted-foreground" />
                  {application.email ?? "—"}
                </p>
                <p>
                  <span className="text-muted-foreground">Recruiter: </span>
                  {application.recruiter?.name ?? "Unassigned"}
                </p>
                <p>
                  <span className="text-muted-foreground">Applied: </span>
                  {formatDate(application.createdAt)}
                </p>
                {application.resumeUrl && /^https?:\/\//i.test(application.resumeUrl) ? (
                  <a
                    href={application.resumeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  >
                    Resume <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
                {application.extra
                  ? Object.entries(application.extra).map(([key, value]) => (
                      <p key={key}>
                        <span className="text-muted-foreground">{key}: </span>
                        {value}
                      </p>
                    ))
                  : null}
              </CardContent>
            </Card>

            <WorkCard key={`${application.status}-${application.notes ?? ""}`} application={application} />
          </div>
        </>
      )}
    </div>
  );
}
