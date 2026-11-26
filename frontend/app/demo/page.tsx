"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import axios from "axios";
import { FlaskConical, ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BACKEND_URL } from "@/lib/api-client/client";
import type { ApiEnvelope } from "@/lib/api-client/types/common.types";
import { useDemo } from "@/hooks/useDemo";
import { useAuthStore } from "@/stores/auth-store";
import { isDemoUser } from "@/lib/demo";

type Availability = "checking" | "available" | "unavailable";

/** The controlled Demo entry: no username or password, nothing real behind it. The access code (if the owner set one) is checked by the server. */
export default function DemoLandingPage() {
  const { start, busy, error } = useDemo();
  const user = useAuthStore((s) => s.user);
  const inDemo = isDemoUser(user);
  const [availability, setAvailability] = useState<Availability>("checking");
  const [codeRequired, setCodeRequired] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    axios
      .get<ApiEnvelope<{ enabled: boolean; accessCodeRequired: boolean }>>(`${BACKEND_URL}/demo/status`, { withCredentials: false })
      .then((res) => {
        if (cancelled) return;
        setCodeRequired(res.data.data.accessCodeRequired);
        setAvailability("available");
      })
      .catch(() => !cancelled && setAvailability("unavailable"));
    return () => {
      cancelled = true;
    };
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    void start(code.trim() || undefined);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-14" />
          <div className="space-y-1">
            <h1 className="text-3xl leading-tight font-semibold tracking-tight">Avance Sales CRM</h1>
            <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold tracking-wide text-amber-950 uppercase">
              <FlaskConical className="size-3.5" aria-hidden /> Demo
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Explore the CRM with sample data</CardTitle>
            <CardDescription>Look around as an Admin, a Manager or a Telecaller and switch between them any time. Everything you see is fictional.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                <span>Separate from the live system: no real customers, orders or payments.</span>
              </li>
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                <span>No messages, calls, payments or shipments are ever sent.</span>
              </li>
            </ul>

            {availability === "unavailable" ? (
              <p role="alert" className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                The demo is not available right now.
              </p>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                {codeRequired ? (
                  <div className="space-y-2">
                    <Label htmlFor="demo-code">Access code</Label>
                    <Input id="demo-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required placeholder="Provided by the team that shared this demo" />
                  </div>
                ) : null}
                {error ? (
                  <p role="alert" className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <Button type="submit" size="lg" className="w-full" disabled={busy || availability === "checking"} data-testid="demo-start">
                  {busy ? "Starting…" : inDemo ? "Restart the demo" : "Start the demo"}
                </Button>
                {inDemo ? (
                  <Link href="/dashboard" className="block text-center text-sm font-medium underline-offset-4 hover:underline">
                    Continue the demo in progress
                  </Link>
                ) : null}
              </form>
            )}
          </CardContent>
        </Card>
        <p className="text-center text-sm text-muted-foreground">
          Have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
