"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, MessageCircle, Pencil, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCustomer360 } from "@/hooks/useCustomers";
import { useAuthStore } from "@/stores/auth-store";
import { SendWhatsAppDialog } from "@/components/whatsapp/send-whatsapp-dialog";
import { WhatsAppConversation } from "@/components/whatsapp/conversation/whatsapp-conversation";
import { EditLeadDialog } from "@/components/leads/edit-lead-dialog";
import { DeleteLeadDialog } from "@/components/leads/delete-lead-dialog";
import { CustomerProfileCard } from "./customer-profile-card";
import { CustomerSegmentCard } from "./customer-segment-card";
import { NextBestActionCard } from "./next-best-action-card";
import { CustomerPaymentSummaryCard } from "./customer-payment-summary-card";
import { CustomerOrdersList } from "./customer-orders-list";
import { CustomerTimeline } from "./customer-timeline";
import { customer360Sections, READ_ONLY_NOTICE } from "./customer-360-access";

const ORDERS_HREF = "/dashboard/orders";

function BackLink() {
  return (
    <Link href={ORDERS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to orders
    </Link>
  );
}

function Customer360Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading customer">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40" />
      <Skeleton className="h-32" />
      <Skeleton className="h-48" />
    </div>
  );
}

export function Customer360View({ leadId }: { leadId: string }) {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const { data, isLoading, error, refetch } = useCustomer360(leadId);
  const [sendOpen, setSendOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isLoading) return <Customer360Skeleton />;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div role="alert" className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm text-destructive">{error ?? "Failed to load customer."}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const currency = data.latestOrder?.currency ?? "INR";
  // A customer reached from a visible order but not owned by this user comes back readOnly: profile + orders only (see customer-360-access.ts).
  const readOnly = Boolean(data.readOnly);
  const show = customer360Sections({ readOnly, role });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink />
        <div className="flex flex-wrap gap-2">
          {show.edit ? (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
          ) : null}
          {show.delete ? (
            <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          ) : null}
          {show.sendWhatsApp ? (
            <Button size="sm" onClick={() => setSendOpen(true)} disabled={!data.profile.mobile}>
              <MessageCircle data-icon="inline-start" />
              Send WhatsApp
            </Button>
          ) : null}
        </div>
      </div>
      {readOnly ? (
        <p role="status" data-testid="customer-360-readonly" className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {READ_ONLY_NOTICE}
        </p>
      ) : null}
      <CustomerProfileCard customer={data} />
      <CustomerSegmentCard segment={data.segment} currency={currency} />
      <NextBestActionCard nba={data.nextBestAction} />
      <CustomerPaymentSummaryCard summary={data.paymentSummary} currency={currency} />
      <CustomerOrdersList orders={data.orders} />
      {show.conversation ? <WhatsAppConversation leadId={leadId} onStartWhatsApp={data.profile.mobile ? () => setSendOpen(true) : undefined} /> : null}
      {show.timeline ? <CustomerTimeline leadId={leadId} /> : null}
      {show.history ? (
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <Link href={`/dashboard/leads/${leadId}`} className="text-sm text-primary hover:underline">
          View lead & assignment history
        </Link>
        <Link href={`/dashboard/audit?leadId=${leadId}`} className="text-sm text-primary hover:underline">
          View full audit trail for this customer
        </Link>
      </div>
      ) : null}
      <SendWhatsAppDialog open={sendOpen} onOpenChange={setSendOpen} leadId={leadId} customerName={data.profile.name} orders={data.orders} />
      <EditLeadDialog leadId={leadId} open={editOpen} onOpenChange={setEditOpen} onDone={() => setEditOpen(false)} />
      <DeleteLeadDialog
        lead={{ id: leadId, name: data.profile.name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => router.push(ORDERS_HREF)}
      />
    </div>
  );
}
