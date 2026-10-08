"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Contact, Search, Users2 } from "lucide-react";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function SalespersonsPage() {
  const { data: salespersons, isPending, error } = useQuery(mySalespersonsQueryOptions());
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const list = salespersons ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (sp) =>
        sp.name.toLowerCase().includes(q) ||
        sp.username.toLowerCase().includes(q) ||
        (sp.groupName ?? "").toLowerCase().includes(q),
    );
  }, [salespersons, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Salespersons"
        description="Everyone reporting to you, in one place. Adding, editing, or removing salespersons is managed by Admin/HR."
      />

      {salespersons && salespersons.length > 0 ? (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, username, or group..."
            className="pl-9.5"
          />
        </div>
      ) : null}

      {isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load salespersons.")}
        </div>
      ) : (salespersons?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14">
            <Users2 className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">No salespeople yet</p>
            <p className="font-hand text-base text-muted-foreground">Ask Admin or HR to assign salespeople to you.</p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14">
            <Contact className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">No matches</p>
            <p className="font-hand text-base text-muted-foreground">Try a different search term.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Salesperson</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead className="pr-5">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((sp) => (
                  <TableRow key={sp.id}>
                    <TableCell className="pl-5">
                      <div className="font-semibold">{sp.name}</div>
                      <div className="text-xs text-muted-foreground">{sp.username}</div>
                    </TableCell>
                    <TableCell>{sp.phone ?? "—"}</TableCell>
                    <TableCell>
                      {sp.groupName ? (
                        <Badge variant="outline">{sp.groupName}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not in a team yet</span>
                      )}
                    </TableCell>
                    <TableCell className="pr-5">
                      <Badge variant={sp.status === "ACTIVE" ? "default" : "secondary"}>
                        {sp.status === "ACTIVE" ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
