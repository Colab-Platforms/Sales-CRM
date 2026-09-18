-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'MANAGER', 'SALESPERSON');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "group_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "lead_working_status" AS ENUM ('NEW', 'ASSIGNED', 'WORKING', 'INTERESTED', 'EXPIRED', 'CONVERTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "lead_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "assignment_type" AS ENUM ('ROUND_ROBIN', 'MANUAL', 'REASSIGNMENT');

-- CreateEnum
CREATE TYPE "interested_period_status" AS ENUM ('ACTIVE', 'CONVERTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "call_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('INITIATED', 'RINGING_AGENT', 'AGENT_ANSWERED', 'RINGING_CUSTOMER', 'CONNECTED', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'NOT_REACHABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "call_outcome_category" AS ENUM ('CONNECTED', 'NOT_CONNECTED', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'OTHER');

-- CreateEnum
CREATE TYPE "task_type" AS ENUM ('CALL', 'CALLBACK', 'FOLLOW_UP', 'OTHER');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "task_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "communication_channel" AS ENUM ('CALL', 'WHATSAPP', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "communication_preference_status" AS ENUM ('OPTED_IN', 'OPTED_OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "product_type" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "source_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "virtual_number_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'CANCELLED', 'RETURNED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "order_source" AS ENUM ('SALESPERSON', 'WEBSITE', 'API');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD', 'UPI', 'NET_BANKING', 'WALLET', 'PAYMENT_LINK', 'OTHER');

-- CreateEnum
CREATE TYPE "abandonment_type" AS ENUM ('CHECKOUT', 'PAYMENT', 'SALES');

-- CreateEnum
CREATE TYPE "abandonment_status" AS ENUM ('ACTIVE', 'IN_PROGRESS', 'RECOVERED', 'NOT_RECOVERED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "recovery_action_type" AS ENUM ('CALL', 'CALLBACK', 'CONTINUE_ORDER');

-- CreateEnum
CREATE TYPE "recovery_action_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('LEAD_CREATED', 'LEAD_UPDATED', 'ASSIGNMENT', 'REASSIGNMENT', 'CALL', 'NOTE', 'STATUS_CHANGE', 'INTERESTED', 'INTERESTED_EXPIRED', 'ORDER_CREATED', 'ORDER_CONFIRMED', 'PAYMENT', 'ABANDONMENT', 'RECOVERY', 'TASK');

-- CreateEnum
CREATE TYPE "webhook_status" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "abandonments" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" "abandonment_type" NOT NULL,
    "source_id" UUID,
    "reference_type" VARCHAR(100),
    "reference_id" VARCHAR(255),
    "detected_at" TIMESTAMP(3) NOT NULL,
    "status" "abandonment_status" NOT NULL DEFAULT 'ACTIVE',
    "priority_score" DECIMAL(5,2),
    "priority_reason" TEXT,
    "recovered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandonments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_actions" (
    "id" UUID NOT NULL,
    "abandonment_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" "recovery_action_type" NOT NULL,
    "status" "recovery_action_status" NOT NULL DEFAULT 'PENDING',
    "performed_by_id" UUID,
    "call_id" UUID,
    "task_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "recovery_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" "activity_type" NOT NULL,
    "reference_type" VARCHAR(100),
    "reference_id" VARCHAR(255),
    "title" VARCHAR(255),
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_numbers" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "display_name" VARCHAR(100),
    "provider" VARCHAR(100) NOT NULL,
    "provider_number_id" VARCHAR(200),
    "group_id" UUID,
    "status" "virtual_number_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_outcomes" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "category" "call_outcome_category" NOT NULL,
    "requires_followup" BOOLEAN NOT NULL DEFAULT false,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "virtual_number_id" UUID,
    "provider" VARCHAR(100) NOT NULL,
    "provider_call_id" VARCHAR(255),
    "direction" "call_direction" NOT NULL,
    "status" "call_status" NOT NULL,
    "agent_number" VARCHAR(30),
    "customer_number" VARCHAR(30),
    "started_at" TIMESTAMP(3),
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "outcome_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_recordings" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "provider_recording_id" VARCHAR(255),
    "recording_url" TEXT,
    "storage_provider" VARCHAR(100),
    "duration_seconds" INTEGER,
    "file_size_bytes" BIGINT,
    "status" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_transcripts" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "transcript_text" TEXT,
    "language" VARCHAR(20),
    "provider" VARCHAR(100),
    "status" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "type" "product_type" NOT NULL,
    "status" "product_status" NOT NULL DEFAULT 'ACTIVE',
    "base_price" DECIMAL(12,2),
    "sku" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "sku" VARCHAR(100),
    "price" DECIMAL(12,2),
    "status" "product_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interested_lead_periods" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "qualified_by_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "status" "interested_period_status" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interested_lead_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "lead_number" VARCHAR(50) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "mobile" VARCHAR(20),
    "normalized_mobile" VARCHAR(20),
    "email" VARCHAR(255),
    "normalized_email" VARCHAR(255),
    "requirement" TEXT,
    "location" VARCHAR(255),
    "source_id" UUID,
    "interested_product_id" UUID,
    "owner_id" UUID,
    "group_id" UUID,
    "working_status" "lead_working_status" NOT NULL DEFAULT 'NEW',
    "priority" "lead_priority" NOT NULL DEFAULT 'MEDIUM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_contacted_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "group_id" UUID,
    "assignment_type" "assignment_type" NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL,
    "unassigned_at" TIMESTAMP(3),
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_assignment_configs" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "strategy" VARCHAR(50) NOT NULL DEFAULT 'ROUND_ROBIN',
    "last_assigned_user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_assignment_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_preferences" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "channel" "communication_channel" NOT NULL,
    "status" "communication_preference_status" NOT NULL DEFAULT 'UNKNOWN',
    "source" VARCHAR(100),
    "consent_at" TIMESTAMP(3),
    "opted_out_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(50) NOT NULL,
    "lead_id" UUID NOT NULL,
    "created_by_id" UUID,
    "source" "order_source" NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(10) NOT NULL DEFAULT 'INR',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shipping_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "placed_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID,
    "variant_id" UUID,
    "product_name_snapshot" VARCHAR(200) NOT NULL,
    "variant_name_snapshot" VARCHAR(200),
    "sku_snapshot" VARCHAR(100),
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_price" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(100),
    "provider_payment_id" VARCHAR(255),
    "provider_order_id" VARCHAR(255),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'INR',
    "method" "payment_method",
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "transaction_reference" VARCHAR(255),
    "paid_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "code" VARCHAR(100),
    "description" TEXT,
    "status" "source_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "assigned_to_id" UUID NOT NULL,
    "created_by_id" UUID,
    "type" "task_type" NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'PENDING',
    "priority" "task_priority" NOT NULL DEFAULT 'MEDIUM',
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20),
    "password_hash" VARCHAR(255),
    "role" "role" NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "manager_id" UUID NOT NULL,
    "status" "group_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(150) NOT NULL,
    "external_event_id" VARCHAR(255),
    "payload" JSONB NOT NULL,
    "status" "webhook_status" NOT NULL DEFAULT 'RECEIVED',
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "abandonments_lead_id_idx" ON "abandonments"("lead_id");

-- CreateIndex
CREATE INDEX "abandonments_source_id_idx" ON "abandonments"("source_id");

-- CreateIndex
CREATE INDEX "abandonments_type_idx" ON "abandonments"("type");

-- CreateIndex
CREATE INDEX "abandonments_status_idx" ON "abandonments"("status");

-- CreateIndex
CREATE INDEX "abandonments_detected_at_idx" ON "abandonments"("detected_at");

-- CreateIndex
CREATE INDEX "abandonments_status_priority_score_idx" ON "abandonments"("status", "priority_score");

-- CreateIndex
CREATE INDEX "recovery_actions_abandonment_id_idx" ON "recovery_actions"("abandonment_id");

-- CreateIndex
CREATE INDEX "recovery_actions_lead_id_idx" ON "recovery_actions"("lead_id");

-- CreateIndex
CREATE INDEX "recovery_actions_type_idx" ON "recovery_actions"("type");

-- CreateIndex
CREATE INDEX "recovery_actions_status_idx" ON "recovery_actions"("status");

-- CreateIndex
CREATE INDEX "activities_lead_id_idx" ON "activities"("lead_id");

-- CreateIndex
CREATE INDEX "activities_actor_id_idx" ON "activities"("actor_id");

-- CreateIndex
CREATE INDEX "activities_type_idx" ON "activities"("type");

-- CreateIndex
CREATE INDEX "activities_created_at_idx" ON "activities"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_numbers_number_key" ON "virtual_numbers"("number");

-- CreateIndex
CREATE INDEX "virtual_numbers_group_id_idx" ON "virtual_numbers"("group_id");

-- CreateIndex
CREATE INDEX "virtual_numbers_provider_idx" ON "virtual_numbers"("provider");

-- CreateIndex
CREATE INDEX "virtual_numbers_status_idx" ON "virtual_numbers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "call_outcomes_code_key" ON "call_outcomes"("code");

-- CreateIndex
CREATE INDEX "calls_lead_id_idx" ON "calls"("lead_id");

-- CreateIndex
CREATE INDEX "calls_agent_id_idx" ON "calls"("agent_id");

-- CreateIndex
CREATE INDEX "calls_virtual_number_id_idx" ON "calls"("virtual_number_id");

-- CreateIndex
CREATE INDEX "calls_provider_call_id_idx" ON "calls"("provider_call_id");

-- CreateIndex
CREATE INDEX "calls_status_idx" ON "calls"("status");

-- CreateIndex
CREATE INDEX "calls_started_at_idx" ON "calls"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "call_recordings_call_id_key" ON "call_recordings"("call_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_transcripts_call_id_key" ON "call_transcripts"("call_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE INDEX "products_type_idx" ON "products"("type");

-- CreateIndex
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex
CREATE INDEX "product_variants_status_idx" ON "product_variants"("status");

-- CreateIndex
CREATE INDEX "interested_lead_periods_lead_id_idx" ON "interested_lead_periods"("lead_id");

-- CreateIndex
CREATE INDEX "interested_lead_periods_status_idx" ON "interested_lead_periods"("status");

-- CreateIndex
CREATE INDEX "interested_lead_periods_expires_at_idx" ON "interested_lead_periods"("expires_at");

-- CreateIndex
CREATE INDEX "interested_lead_periods_status_expires_at_idx" ON "interested_lead_periods"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_lead_number_key" ON "leads"("lead_number");

-- CreateIndex
CREATE INDEX "leads_normalized_mobile_idx" ON "leads"("normalized_mobile");

-- CreateIndex
CREATE INDEX "leads_normalized_email_idx" ON "leads"("normalized_email");

-- CreateIndex
CREATE INDEX "leads_source_id_idx" ON "leads"("source_id");

-- CreateIndex
CREATE INDEX "leads_owner_id_idx" ON "leads"("owner_id");

-- CreateIndex
CREATE INDEX "leads_group_id_idx" ON "leads"("group_id");

-- CreateIndex
CREATE INDEX "leads_working_status_idx" ON "leads"("working_status");

-- CreateIndex
CREATE INDEX "leads_priority_idx" ON "leads"("priority");

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE INDEX "lead_assignments_lead_id_idx" ON "lead_assignments"("lead_id");

-- CreateIndex
CREATE INDEX "lead_assignments_user_id_idx" ON "lead_assignments"("user_id");

-- CreateIndex
CREATE INDEX "lead_assignments_group_id_idx" ON "lead_assignments"("group_id");

-- CreateIndex
CREATE INDEX "lead_assignments_assigned_at_idx" ON "lead_assignments"("assigned_at");

-- CreateIndex
CREATE INDEX "lead_assignments_is_current_idx" ON "lead_assignments"("is_current");

-- CreateIndex
CREATE UNIQUE INDEX "group_assignment_configs_group_id_key" ON "group_assignment_configs"("group_id");

-- CreateIndex
CREATE INDEX "communication_preferences_status_idx" ON "communication_preferences"("status");

-- CreateIndex
CREATE UNIQUE INDEX "communication_preferences_lead_id_channel_key" ON "communication_preferences"("lead_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_lead_id_idx" ON "orders"("lead_id");

-- CreateIndex
CREATE INDEX "orders_created_by_id_idx" ON "orders"("created_by_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_source_idx" ON "orders"("source");

-- CreateIndex
CREATE INDEX "orders_placed_at_idx" ON "orders"("placed_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_provider_payment_id_idx" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_provider_order_id_idx" ON "payments"("provider_order_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sources_code_key" ON "sources"("code");

-- CreateIndex
CREATE INDEX "tasks_lead_id_idx" ON "tasks"("lead_id");

-- CreateIndex
CREATE INDEX "tasks_assigned_to_id_idx" ON "tasks"("assigned_to_id");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_scheduled_at_idx" ON "tasks"("scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "groups_manager_id_idx" ON "groups"("manager_id");

-- CreateIndex
CREATE INDEX "groups_status_idx" ON "groups"("status");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_group_id_user_id_key" ON "group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "webhook_events_provider_idx" ON "webhook_events"("provider");

-- CreateIndex
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events"("event_type");

-- CreateIndex
CREATE INDEX "webhook_events_external_event_id_idx" ON "webhook_events"("external_event_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- AddForeignKey
ALTER TABLE "abandonments" ADD CONSTRAINT "abandonments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abandonments" ADD CONSTRAINT "abandonments_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_abandonment_id_fkey" FOREIGN KEY ("abandonment_id") REFERENCES "abandonments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_numbers" ADD CONSTRAINT "virtual_numbers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_virtual_number_id_fkey" FOREIGN KEY ("virtual_number_id") REFERENCES "virtual_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "call_outcomes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interested_lead_periods" ADD CONSTRAINT "interested_lead_periods_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interested_lead_periods" ADD CONSTRAINT "interested_lead_periods_qualified_by_id_fkey" FOREIGN KEY ("qualified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_interested_product_id_fkey" FOREIGN KEY ("interested_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_assignment_configs" ADD CONSTRAINT "group_assignment_configs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_assignment_configs" ADD CONSTRAINT "group_assignment_configs_last_assigned_user_id_fkey" FOREIGN KEY ("last_assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
