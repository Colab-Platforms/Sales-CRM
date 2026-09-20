"use client";

import { useState, type FormEvent } from "react";
import { useCreateSalespersonMutation } from "@/lib/api-client/mutations/manager.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Group } from "@/lib/api-client/types/manager.types";

export function CreateSalespersonModal({ groups, onDone }: { groups: Group[]; onDone: () => void }) {
  const createSalesperson = useCreateSalespersonMutation();
  const activeGroups = groups.filter((g) => g.status === "ACTIVE");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [groupId, setGroupId] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createSalesperson.mutate(
      { name, email, password, phone: phone || undefined, groupId },
      { onSuccess: onDone },
    );
  }

  if (activeGroups.length === 0) {
    return (
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Add Salesperson</DialogTitle>
          <DialogDescription>You need an active group before you can add a salesperson.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Add Salesperson</DialogTitle>
        <DialogDescription>Create a new salesperson account and assign them to a group.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-sp-name">Name</Label>
          <Input id="new-sp-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-sp-email">Email</Label>
          <Input
            id="new-sp-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-sp-password">Password</Label>
          <PasswordInput id="new-sp-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="new-sp-phone">Phone</Label>
            <span className="text-xs text-muted-foreground">Optional</span>
          </div>
          <Input id="new-sp-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-sp-group">Group</Label>
          <NativeSelect
            id="new-sp-group"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            required
          >
            <option value="" disabled>
              Select a group
            </option>
            {activeGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </NativeSelect>
        </div>

        {createSalesperson.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(createSalesperson.error, "Failed to create salesperson.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={createSalesperson.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createSalesperson.isPending}>
            {createSalesperson.isPending ? "Creating..." : "Add Salesperson"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
