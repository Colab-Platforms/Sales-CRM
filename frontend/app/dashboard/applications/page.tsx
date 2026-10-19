"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Search } from "lucide-react";
import { applicationsQueryOptions, jobsQueryOptions } from "@/lib/api-client/queries/recruitment.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { useUpdateApplicationMutation } from "@/lib/api-client/mutations/recruitment.mutations";
import { FILTER_STATUSES, RECRUITER_STATUSES, type Application, type ApplicationStatus } from "@/lib/api-client/types/recruitment.types";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddApplicationDialog } from "@/components/recruitment/add-application-dialog";
import { applicationStatusClasses, applicationStatusLabel } from "@/components/recruitment/application-status-badge";

const PAGE_SIZE = 25;

// Inline status change. The select shows the current status; a status the recruiter can't set by hand
// (e.g. Assigned) stays listed as the current value but can only be moved to one of the four outcomes.
function StatusSelect({ application }: { application: Application }) {
  const update = useUpdateApplicationMutation();
  const current = application.status;
  return (
    <NativeSelect
      size="sm"
      aria-label={`Status for ${application.name}`}
      wrapperClassName="w-40"
      className={`font-semibold ${applicationStatusClasses(current)}`}
      value={current}
      disabled={update.isPending}
      onChange={(e) =>
        update.mutate(
          { id: application.id, payload: { status: e.target.value as ApplicationStatus } },
          {
            onSuccess: () => toast.success(`${application.name} marked ${applicationStatusLabel(e.target.value as ApplicationStatus).toLowerCase()}.`),
            onError: (error) => toast.error(getErrorMessage(error, "Failed to update status.")),
          },
        )
      }
    >
      {RECRUITER_STATUSES.includes(current) ? null : (
        <option value={current} disabled>
          {applicationStatusLabel(current)}
        </option>
      )}
      {RECRUITER_STATUSES.map((s) => (
        <option key={s} value={s}>
          {applicationStatusLabel(s)}
        </option>
      ))}
    </NativeSelect>
  );
}

export default function MyApplicationsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ApplicationStatus | "">("");
  const [addOpen, setAddOpen] = useState(false);
  const { data: jobs = [] } = useQuery(jobsQueryOptions());

  const { data, isPending, error } = useQuery(applicationsQueryOptions({ page, pageSize: PAGE_SIZE, status, q: search.trim() }));
  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <PageHeader
        title="My applications"
        description="Candidates assigned to you. Open one to update its status."
        actions={
          <Button onClick={() => setAddOpen(true)} disabled={jobs.every((j) => j.status !== "OPEN")}>
            <Plus />
            Add application
          </Button>
        }
      />
      <AddApplicationDialog jobs={jobs.filter((j) => j.status === "OPEN")} open={addOpen} onOpenChange={setAddOpen} />

      <Card>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search applications"
                placeholder="Search name, email or mobile"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-8"
              />
            </div>
            <NativeSelect
              aria-label="Filter by status"
              wrapperClassName="w-44"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as ApplicationStatus | "");
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {FILTER_STATUSES.filter((s) => s !== "NEW").map((s) => (
                <option key={s} value={s}>
                  {applicationStatusLabel(s)}
                </option>
              ))}
            </NativeSelect>
          </div>

          {isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {getErrorMessage(error, "Failed to load applications.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Mobile</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                      {!search && !status ? "Nothing assigned to you yet." : "No applications match these filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-semibold">
                        <Link href={`/dashboard/applications/${a.id}`} className="hover:underline">
                          {a.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{a.job.title}</TableCell>
                      <TableCell>{a.mobile}</TableCell>
                      <TableCell>
                        <StatusSelect application={a} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/dashboard/applications/${a.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          Open
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {data ? `${data.total} application${data.total === 1 ? "" : "s"}` : ""} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
