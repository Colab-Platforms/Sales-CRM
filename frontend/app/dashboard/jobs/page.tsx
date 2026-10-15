"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Briefcase, Plus, UserPlus } from "lucide-react";
import { jobsQueryOptions, distributionQueryOptions } from "@/lib/api-client/queries/recruitment.queries";
import { useCreateJobMutation } from "@/lib/api-client/mutations/recruitment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AddApplicationDialog } from "@/components/recruitment/add-application-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function CreateJobDialogContent({ onDone }: { onDone: () => void }) {
  const createJob = useCreateJobMutation();
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [location, setLocation] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createJob.mutate(
      { title: title.trim(), department: department.trim() || undefined, location: location.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Job created.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>New job</DialogTitle>
        <DialogDescription>Create the job, then import its applications from a CSV.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="job-title">Job title</Label>
          <Input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sales Executive" required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="job-department">Department</Label>
          <Input id="job-department" value={department} onChange={(e) => setDepartment(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="job-location">Location</Label>
          <Input id="job-location" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        {createJob.error ? <p className="text-sm text-destructive">{getErrorMessage(createJob.error, "Failed to create job.")}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={createJob.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createJob.isPending || title.trim().length < 2}>
            {createJob.isPending ? "Creating..." : "Create job"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RecruiterWorkload() {
  const { data, isPending } = useQuery(distributionQueryOptions());
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recruiter workload</CardTitle>
        <CardDescription>
          {data ? `${data.unassigned} application${data.unassigned === 1 ? "" : "s"} waiting to be assigned` : "Loading…"}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {isPending ? (
          <div className="space-y-3 px-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Recruiter</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead className="text-right">To call</TableHead>
                <TableHead className="pr-5 text-right">Shortlisted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.recruiters.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No recruiters yet.
                  </TableCell>
                </TableRow>
              ) : (
                data?.recruiters.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-5 font-semibold">
                      {r.name}
                      {r.status !== "ACTIVE" ? <span className="ml-2 text-xs font-normal text-muted-foreground">inactive</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.pending}</TableCell>
                    <TableCell className="pr-5 text-right tabular-nums">{r.shortlisted}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default function JobsPage() {
  const { data: jobs, isPending, error } = useQuery(jobsQueryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [addApplicationOpen, setAddApplicationOpen] = useState(false);
  const openJobs = jobs?.filter((j) => j.status === "OPEN") ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        description="Import the applications for a job, hand them to recruiters, and export the results."
        actions={
          <>
            <Button variant="outline" onClick={() => setAddApplicationOpen(true)} disabled={openJobs.length === 0}>
              <UserPlus />
              Add application
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              New job
            </Button>
          </>
        }
      />

      <AddApplicationDialog jobs={openJobs} open={addApplicationOpen} onOpenChange={setAddApplicationOpen} />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {createOpen ? <CreateJobDialogContent onDone={() => setCreateOpen(false)} /> : null}
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>All jobs</CardTitle>
          <CardDescription>{jobs ? `${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "Loading jobs…"}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isPending ? (
            <div className="space-y-3 px-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="sketch-outline mx-5 border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {getErrorMessage(error, "Failed to load jobs.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Title</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Applications</TableHead>
                  <TableHead className="text-right">Unassigned</TableHead>
                  <TableHead className="pr-5 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-14 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <Briefcase className="size-9 text-muted-foreground/40" />
                        <p className="font-heading text-lg font-bold">No jobs yet</p>
                        <Button className="mt-2" onClick={() => setCreateOpen(true)}>
                          <Plus />
                          New job
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  jobs?.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="pl-5 font-semibold">{job.title}</TableCell>
                      <TableCell className="text-muted-foreground">{job.department ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{job.location ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={job.status === "OPEN" ? "default" : "secondary"}>{job.status === "OPEN" ? "Open" : "Closed"}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{job.totalApplications}</TableCell>
                      <TableCell className="text-right tabular-nums">{job.unassignedApplications}</TableCell>
                      <TableCell className="pr-5 text-right">
                        <Link href={`/dashboard/jobs/${job.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                          Open
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RecruiterWorkload />
    </div>
  );
}
