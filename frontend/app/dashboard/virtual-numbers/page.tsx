"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Phone, Plus } from "lucide-react";
import { allVirtualNumbersQueryOptions } from "@/lib/api-client/queries/calling.queries";
import {
  useCreateVirtualNumberMutation,
  useUpdateVirtualNumberMutation,
  useDeleteVirtualNumberMutation,
} from "@/lib/api-client/mutations/calling.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { VirtualNumberRecord } from "@/lib/api-client/types/calling.types";

function CreateVirtualNumberModalContent({ onDone }: { onDone: () => void }) {
  const createVirtualNumber = useCreateVirtualNumberMutation();
  const [number, setNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState("CALLERDESK");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createVirtualNumber.mutate(
      { number, displayName: displayName || undefined, provider },
      {
        onSuccess: () => {
          toast.success("Virtual number added successfully.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>Add Virtual Number</DialogTitle>
        <DialogDescription>Salespersons can pick this as their caller ID for click-to-call.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="vn-number">Phone Number</Label>
          <Input
            id="vn-number"
            placeholder="+919876500000"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vn-display-name">Display Name</Label>
          <Input
            id="vn-display-name"
            placeholder="e.g. Sales Line 1"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vn-provider">Provider</Label>
          <Input id="vn-provider" value={provider} onChange={(e) => setProvider(e.target.value)} required />
        </div>

        {createVirtualNumber.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(createVirtualNumber.error, "Failed to create virtual number.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={createVirtualNumber.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createVirtualNumber.isPending}>
            {createVirtualNumber.isPending ? "Adding..." : "Add Number"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function VirtualNumberRow({ virtualNumber }: { virtualNumber: VirtualNumberRecord }) {
  const updateVirtualNumber = useUpdateVirtualNumberMutation();
  const deleteVirtualNumber = useDeleteVirtualNumberMutation();
  const isActive = virtualNumber.status === "ACTIVE";

  return (
    <TableRow>
      <TableCell className="pl-5 font-semibold">{virtualNumber.displayName ?? "—"}</TableCell>
      <TableCell className="font-mono text-sm">{virtualNumber.number}</TableCell>
      <TableCell>
        <Badge variant="outline">{virtualNumber.provider}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Active" : "Inactive"}</Badge>
      </TableCell>
      <TableCell className="pr-5 text-right">
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={updateVirtualNumber.isPending}
            onClick={() =>
              updateVirtualNumber.mutate(
                { id: virtualNumber.id, payload: { status: isActive ? "INACTIVE" : "ACTIVE" } },
                { onSuccess: () => toast.success(isActive ? "Number deactivated" : "Number reactivated") },
              )
            }
          >
            {isActive ? "Deactivate" : "Reactivate"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={deleteVirtualNumber.isPending}
            onClick={() =>
              deleteVirtualNumber.mutate(virtualNumber.id, {
                onSuccess: () => toast.success("Virtual number deleted"),
                onError: (error) => toast.error(getErrorMessage(error, "Failed to delete virtual number.")),
              })
            }
          >
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function VirtualNumbersPage() {
  const { data: virtualNumbers, isPending, error } = useQuery(allVirtualNumbersQueryOptions());
  const [isAddOpen, setIsAddOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Virtual Numbers"
        description="Manage the caller-ID numbers salespersons can pick from for click-to-call."
        actions={
          <Button onClick={() => setIsAddOpen(true)}>
            <Plus />
            Add Number
          </Button>
        }
      />

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        {isAddOpen ? <CreateVirtualNumberModalContent onDone={() => setIsAddOpen(false)} /> : null}
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>All Virtual Numbers</CardTitle>
          <CardDescription>
            {virtualNumbers
              ? `${virtualNumbers.length} number${virtualNumbers.length === 1 ? "" : "s"} configured`
              : "Loading virtual numbers..."}
          </CardDescription>
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
              {getErrorMessage(error, "Failed to load virtual numbers.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {virtualNumbers && virtualNumbers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-14 text-center">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Phone className="size-9 text-muted-foreground/40" />
                        <p className="font-heading text-lg font-bold">No virtual numbers yet</p>
                        <p className="font-hand text-base text-muted-foreground">
                          Add a number so salespersons can use click-to-call.
                        </p>
                        <Button className="mt-3" onClick={() => setIsAddOpen(true)}>
                          <Plus />
                          Add Number
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  virtualNumbers?.map((vn) => <VirtualNumberRow key={vn.id} virtualNumber={vn} />)
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
