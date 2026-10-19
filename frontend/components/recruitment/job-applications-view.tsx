"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Download, Plus, Search, Upload, UserPlus } from "lucide-react";
import { jobApplicationsQueryOptions, jobQueryOptions } from "@/lib/api-client/queries/recruitment.queries";
import { recruitersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { useUpdateJobMutation } from "@/lib/api-client/mutations/recruitment.mutations";
import { recruitmentApi } from "@/lib/api-client/endpoints/recruitment.api";
import { getErrorMessage } from "@/lib/api-client/client";
import { FILTER_STATUSES, type ApplicationStatus } from "@/lib/api-client/types/recruitment.types";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApplicationStatusBadge, applicationStatusLabel } from "./application-status-badge";
import { AddApplicationDialog } from "./add-application-dialog";
import { ImportApplicationsDialog } from "./import-applications-dialog";
import { AssignApplicationsDialog } from "./assign-applications-dialog";

const PAGE_SIZE = 25;

export function JobApplicationsView({ jobId }: { jobId: string }) {
  const { data: job } = useQuery(jobQueryOptions(jobId));
  const { data: recruiters = [] } = useQuery(recruitersQueryOptions());
  const updateJob = useUpdateJobMutation();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ApplicationStatus | "">("");
  const [recruiterId, setRecruiterId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const params = { page, pageSize: PAGE_SIZE, status, recruiterId, q: search.trim() };
  const { data, isPending, error } = useQuery(jobApplicationsQueryOptions(jobId, params));

  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const allOnPageSelected = items.length > 0 && items.every((a) => selected.includes(a.id));

  function resetPaging<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
      setSelected([]);
    };
  }

  function toggleAllOnPage() {
    const ids = items.map((a) => a.id);
    setSelected((prev) => (allOnPageSelected ? prev.filter((id) => !ids.includes(id)) : [...new Set([...prev, ...ids])]));
  }

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await recruitmentApi.exportJobApplications(jobId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `applications-${(job?.title ?? "job").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(getErrorMessage(e, "Failed to export applications."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard/jobs" className={buttonVariants({ variant: "ghost", size: "sm" }) + " w-fit"}>
        <ArrowLeft />
        All jobs
      </Link>

      <PageHeader
        title={job?.title ?? "Job"}
        description={[job?.department, job?.location].filter(Boolean).join(" · ") || "Applications for this job."}
        actions={
          <>
            {job ? (
              <Button
                variant="outline"
                disabled={updateJob.isPending}
                onClick={() => updateJob.mutate({ id: job.id, payload: { status: job.status === "OPEN" ? "CLOSED" : "OPEN" } })}
              >
                {job.status === "OPEN" ? "Close job" : "Reopen job"}
              </Button>
            ) : null}
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Download />
              {exporting ? "Exporting..." : "Export CSV"}
            </Button>
            <Button variant="outline" onClick={() => setAddOpen(true)} disabled={!job}>
              <Plus />
              Add application
            </Button>
            <Button onClick={() => setImportOpen(true)} disabled={!job}>
              <Upload />
              Import applications
            </Button>
          </>
        }
      />

      {job ? <ImportApplicationsDialog jobId={jobId} jobTitle={job.title} open={importOpen} onOpenChange={setImportOpen} /> : null}
      {job ? <AddApplicationDialog jobs={[job]} open={addOpen} onOpenChange={setAddOpen} /> : null}
      <AssignApplicationsDialog
        applicationIds={selected}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        onDone={() => {
          setAssignOpen(false);
          setSelected([]);
        }}
      />

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
                onChange={(e) => resetPaging(setSearch)(e.target.value)}
                className="pl-8"
              />
            </div>
            <NativeSelect
              aria-label="Filter by status"
              wrapperClassName="w-44"
              value={status}
              onChange={(e) => resetPaging(setStatus)(e.target.value as ApplicationStatus | "")}
            >
              <option value="">All statuses</option>
              {FILTER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {applicationStatusLabel(s)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Filter by recruiter"
              wrapperClassName="w-48"
              value={recruiterId}
              onChange={(e) => resetPaging(setRecruiterId)(e.target.value)}
            >
              <option value="">All recruiters</option>
              <option value="unassigned">Unassigned</option>
              {recruiters.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
            <div className="ml-auto flex items-center gap-2">
              {selected.length > 0 ? <span className="text-sm text-muted-foreground">{selected.length} selected</span> : null}
              <Button disabled={selected.length === 0} onClick={() => setAssignOpen(true)}>
                <UserPlus />
                Assign
              </Button>
            </div>
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
                  <TableHead className="w-10">
                    <input type="checkbox" aria-label="Select all on page" checked={allOnPageSelected} onChange={toggleAllOnPage} className="size-4" />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Mobile</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recruiter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                      {data?.total === 0 && !search && !status && !recruiterId
                        ? "No applications yet. Import a CSV to get started."
                        : "No applications match these filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${a.name}`}
                          checked={selected.includes(a.id)}
                          onChange={() => setSelected((prev) => (prev.includes(a.id) ? prev.filter((id) => id !== a.id) : [...prev, a.id]))}
                          className="size-4"
                        />
                      </TableCell>
                      <TableCell className="font-semibold">
                        <Link href={`/dashboard/applications/${a.id}`} className="hover:underline">
                          {a.name}
                        </Link>
                      </TableCell>
                      <TableCell>{a.mobile}</TableCell>
                      <TableCell className="text-muted-foreground">{a.email ?? "—"}</TableCell>
                      <TableCell>
                        <ApplicationStatusBadge status={a.status} />
                      </TableCell>
                      <TableCell>{a.recruiter?.name ?? <Badge variant="outline">Unassigned</Badge>}</TableCell>
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
