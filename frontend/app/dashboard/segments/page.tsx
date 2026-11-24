"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { segmentsQueryOptions } from "@/lib/api-client/queries/segment.queries";
import { useCreateSegmentMutation, useDeleteSegmentMutation, useUpdateSegmentMutation } from "@/lib/api-client/mutations/segment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAuthStore } from "@/stores/auth-store";
import type { Segment } from "@/lib/api-client/types/segment.types";
import { PageHeader } from "@/components/page-header";
import { SegmentTagPill } from "@/components/leads/lead-tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const n = (v: number) => v.toLocaleString("en-IN");

function SegmentRow({ segment }: { segment: Segment }) {
  const update = useUpdateSegmentMutation();
  const remove = useDeleteSegmentMutation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(segment.name);
  const [color, setColor] = useState(segment.color);
  const c = segment.counts;

  function save(e: FormEvent) {
    e.preventDefault();
    update.mutate({ id: segment.id, payload: { name, color } }, { onSuccess: () => { toast.success("Segment updated."); setEditing(false); } });
  }

  return (
    <TableRow data-testid="segment-row">
      <TableCell className="pl-5">
        {editing ? (
          <form onSubmit={save} className="flex flex-wrap items-center gap-2">
            <Input aria-label="Segment name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="w-52" />
            <input type="color" aria-label="Segment colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-10 cursor-pointer rounded border bg-transparent p-0.5" />
            <Button size="sm" type="submit" disabled={update.isPending || !name.trim()}>Save</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => { setEditing(false); setName(segment.name); setColor(segment.color); }}>Cancel</Button>
            {update.error ? <span className="text-xs text-destructive">{getErrorMessage(update.error, "Could not save.")}</span> : null}
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <SegmentTagPill segment={segment} />
            {segment.isSystem ? <span className="text-xs text-muted-foreground">built-in</span> : null}
          </div>
        )}
      </TableCell>
      <TableCell className="tabular-nums">{c ? n(c.total) : "—"}</TableCell>
      <TableCell className="tabular-nums">{c ? n(c.assigned) : "—"}</TableCell>
      <TableCell className="tabular-nums">{c ? n(c.unassigned) : "—"}</TableCell>
      <TableCell>{segment.isActive ? "Active" : "Inactive"}</TableCell>
      <TableCell className="pr-5 text-right">
        <div className="flex flex-wrap justify-end gap-2">
          <Link href={`/dashboard/leads?segmentId=${segment.id}`} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">
            Open leads
          </Link>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
          <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: segment.id, payload: { isActive: !segment.isActive } }, { onSuccess: () => toast.success(segment.isActive ? "Segment deactivated." : "Segment activated.") })}>
            {segment.isActive ? "Deactivate" : "Activate"}
          </Button>
          {!segment.isSystem ? (
            <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(segment.id, { onSuccess: () => toast.success("Segment deleted."), onError: (e) => toast.error(getErrorMessage(e, "Could not delete the segment.")) })}>
              Delete
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function SegmentsPage() {
  const user = useAuthStore((s) => s.user);
  const { data, isPending, error } = useQuery({ ...segmentsQueryOptions({ includeInactive: true, counts: true }), enabled: user?.role === "ADMIN" });
  const create = useCreateSegmentMutation();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  if (!user) return null;
  if (user.role !== "ADMIN") return <p className="text-sm text-muted-foreground">Only an Admin can manage segments.</p>;

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ name, color }, { onSuccess: () => { toast.success("Segment created."); setName(""); } });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Campaign Segments" description="Group leads for a campaign. A segment stays on a lead whoever it is assigned to. A segment with leads can be deactivated but not deleted." />
      <form onSubmit={submit} className="sketch-outline flex flex-wrap items-end gap-3 bg-card/60 p-4">
        <div className="min-w-60 flex-1 space-y-1.5">
          <Label htmlFor="segment-name">New segment</Label>
          <Input id="segment-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali Mega Sale" maxLength={100} />
        </div>
        <input type="color" aria-label="Segment colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-10 cursor-pointer rounded border bg-transparent p-0.5" />
        <Button type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? "Creating..." : "Create segment"}</Button>
        {create.error ? <p className="w-full text-sm text-destructive">{getErrorMessage(create.error, "Could not create the segment.")}</p> : null}
      </form>
      {error ? <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load segments.")}</p> : null}
      <div className="sketch-outline overflow-x-auto bg-card/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Segment</TableHead>
              <TableHead>Total leads</TableHead>
              <TableHead>Assigned</TableHead>
              <TableHead>Unassigned</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-5 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
            ) : (
              (data ?? []).map((s) => <SegmentRow key={s.id} segment={s} />)
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">Counts are for leads (not abandoned carts). <Link href="/dashboard/leads" className="underline">Open all leads</Link></p>
    </div>
  );
}
