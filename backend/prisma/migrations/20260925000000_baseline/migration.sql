-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

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
CREATE TYPE "import_batch_status" AS ENUM ('DRAFT', 'COMMITTED', 'FAILED');

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
CREATE TYPE "source_type" AS ENUM ('MANUAL', 'CSV', 'META', 'SHOPIFY', 'API');
CREATE TYPE "source_type" AS ENUM ('MANUAL', 'CSV', 'META', 'SHOPIFY', 'API', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "virtual_number_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'CANCELLED', 'RETURNED', 'REFUNDED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED');

-- CreateEnum
CREATE TYPE "shipment_status" AS ENUM ('SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'CREATED', 'AWB_ASSIGNED', 'PICKUP_SCHEDULED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "order_source" AS ENUM ('SALESPERSON', 'WEBSITE', 'API', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD', 'UPI', 'NET_BANKING', 'WALLET', 'PAYMENT_LINK', 'OTHER', 'COD');

-- CreateEnum
CREATE TYPE "abandonment_type" AS ENUM ('CHECKOUT', 'PAYMENT', 'SALES');

-- CreateEnum
CREATE TYPE "abandonment_status" AS ENUM ('ACTIVE', 'IN_PROGRESS', 'RECOVERED', 'NOT_RECOVERED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "recovery_action_type" AS ENUM ('CALL', 'CALLBACK', 'CONTINUE_ORDER');

-- CreateEnum
CREATE TYPE "recovery_action_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('LEAD_CREATED', 'LEAD_UPDATED', 'ASSIGNMENT', 'REASSIGNMENT', 'CALL', 'NOTE', 'STATUS_CHANGE', 'INTERESTED', 'INTERESTED_EXPIRED', 'ORDER_CREATED', 'ORDER_CONFIRMED', 'PAYMENT', 'ABANDONMENT', 'RECOVERY', 'TASK', 'ORDER_STATUS_CHANGED', 'ORDER_CANCELLED', 'PAYMENT_CREATED', 'PAYMENT_STATUS_CHANGED', 'PAYMENT_REFUNDED', 'PAYMENT_MISMATCH_DETECTED', 'SHIPMENT_CREATED', 'SHIPMENT_STATUS_CHANGED', 'TRACKING_UPDATED', 'DISCOUNT_CHANGED', 'WHATSAPP_MESSAGE_SENT', 'WHATSAPP_MESSAGE_RECEIVED', 'WHATSAPP_DELIVERED', 'WHATSAPP_READ', 'WHATSAPP_FAILED', 'WHATSAPP_TEMPLATE_CREATED', 'WHATSAPP_TEMPLATE_UPDATED', 'WHATSAPP_TEMPLATE_STATUS_CHANGED', 'WHATSAPP_TEMPLATE_SYNCED', 'WHATSAPP_CAMPAIGN_CREATED', 'WHATSAPP_CAMPAIGN_LAUNCHED', 'WHATSAPP_CAMPAIGN_CANCELLED', 'WHATSAPP_CAMPAIGN_COMPLETED', 'PAYMENT_LINK_CREATED', 'PAYMENT_LINK_CANCELLED', 'SHIPMENT_AWB_ASSIGNED', 'SHIPMENT_PICKUP_SCHEDULED', 'SHIPMENT_LABEL_GENERATED');

-- CreateEnum
CREATE TYPE "activity_source" AS ENUM ('USER', 'SHOPIFY_SYNC', 'SHOPIFY_WEBHOOK', 'SYSTEM', 'WHATSAPP_WEBHOOK', 'CASHFREE_WEBHOOK', 'SHIPROCKET_WEBHOOK');

-- CreateEnum
CREATE TYPE "whatsapp_provider_name" AS ENUM ('AISENSY', 'GUPSHUP');
CREATE TYPE "activity_type" AS ENUM ('LEAD_CREATED', 'LEAD_UPDATED', 'ASSIGNMENT', 'REASSIGNMENT', 'CALL', 'NOTE', 'STATUS_CHANGE', 'INTERESTED', 'INTERESTED_EXPIRED', 'ORDER_CREATED', 'ORDER_CONFIRMED', 'PAYMENT', 'ABANDONMENT', 'RECOVERY', 'TASK', 'ORDER_STATUS_CHANGED', 'ORDER_CANCELLED', 'PAYMENT_CREATED', 'PAYMENT_STATUS_CHANGED', 'PAYMENT_REFUNDED', 'PAYMENT_MISMATCH_DETECTED', 'SHIPMENT_CREATED', 'SHIPMENT_STATUS_CHANGED', 'TRACKING_UPDATED', 'DISCOUNT_CHANGED', 'WHATSAPP_MESSAGE_SENT', 'WHATSAPP_MESSAGE_RECEIVED', 'WHATSAPP_DELIVERED', 'WHATSAPP_READ', 'WHATSAPP_FAILED', 'WHATSAPP_TEMPLATE_CREATED', 'WHATSAPP_TEMPLATE_UPDATED', 'WHATSAPP_TEMPLATE_STATUS_CHANGED', 'WHATSAPP_TEMPLATE_SYNCED', 'WHATSAPP_CAMPAIGN_CREATED', 'WHATSAPP_CAMPAIGN_LAUNCHED', 'WHATSAPP_CAMPAIGN_CANCELLED', 'WHATSAPP_CAMPAIGN_COMPLETED', 'PAYMENT_LINK_CREATED', 'PAYMENT_LINK_CANCELLED', 'SHIPMENT_AWB_ASSIGNED', 'SHIPMENT_PICKUP_SCHEDULED', 'SHIPMENT_LABEL_GENERATED', 'WHATSAPP_CLOUD_CONFIG_CREATED', 'WHATSAPP_CLOUD_CONFIG_UPDATED', 'WHATSAPP_CLOUD_CONFIG_RESET', 'WHATSAPP_CLOUD_CONFIG_TESTED', 'WHATSAPP_CLOUD_CONFIG_WEBHOOK_VERIFIED', 'CONVERSATION_ASSIGNED', 'CONVERSATION_AI_HANDOFF', 'CONVERSATION_HUMAN_HANDBACK');

-- CreateEnum
CREATE TYPE "activity_source" AS ENUM ('USER', 'SHOPIFY_SYNC', 'SHOPIFY_WEBHOOK', 'SYSTEM', 'WHATSAPP_WEBHOOK', 'CASHFREE_WEBHOOK', 'SHIPROCKET_WEBHOOK', 'WHATSAPP_CLOUD_WEBHOOK');

-- CreateEnum
CREATE TYPE "whatsapp_provider_name" AS ENUM ('AISENSY', 'GUPSHUP', 'META');

-- CreateEnum
CREATE TYPE "whatsapp_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "conversation_mode" AS ENUM ('AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "order_conversation_state" AS ENUM ('DISCOVERY', 'PRODUCT_SELECTED', 'QUANTITY_SELECTED', 'CUSTOMER_DETAILS', 'ADDRESS_REQUIRED', 'ADDRESS_CONFIRMED', 'PAYMENT_METHOD', 'ORDER_REVIEW', 'CUSTOMER_CONFIRMED', 'ORDER_CREATED');

-- CreateEnum
CREATE TYPE "whatsapp_message_type" AS ENUM ('TEXT', 'TEMPLATE', 'MEDIA', 'INTERACTIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "whatsapp_message_status" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "whatsapp_template_status" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "whatsapp_automation_type" AS ENUM ('ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'PAYMENT_PENDING', 'FOLLOW_UP_DUE');

-- CreateEnum
CREATE TYPE "whatsapp_automation_run_status" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "whatsapp_campaign_status" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "whatsapp_campaign_recipient_status" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "webhook_status" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "external_source" AS ENUM ('SHOPIFY', 'CASHFREE', 'SHIPROCKET');

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
    "lead_id" UUID,
    "actor_id" UUID,
    "actor_role" "role",
    "type" "activity_type" NOT NULL,
    "reference_type" VARCHAR(100),
    "reference_id" VARCHAR(255),
    "order_id" UUID,
    "source" "activity_source" NOT NULL DEFAULT 'SYSTEM',
    "title" VARCHAR(255),
    "description" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "metadata" JSONB,
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
    "external_source" "external_source",
    "external_id" VARCHAR(100),
    "external_updated_at" TIMESTAMP(3),
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
    "external_source" "external_source",
    "external_id" VARCHAR(100),
    "external_updated_at" TIMESTAMP(3),
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
    "assigned_manager_id" UUID,
    "import_batch_id" UUID,
    "working_status" "lead_working_status" NOT NULL DEFAULT 'NEW',
    "priority" "lead_priority" NOT NULL DEFAULT 'MEDIUM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_contacted_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "external_source" "external_source",
    "external_id" VARCHAR(100),
    "external_updated_at" TIMESTAMP(3),

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
CREATE TABLE "lead_import_batches" (
    "id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "status" "import_batch_status" NOT NULL DEFAULT 'DRAFT',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "column_mapping" JSONB NOT NULL,
    "parsed_rows" JSONB,
    "error_rows" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMP(3),

    CONSTRAINT "lead_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_assignment_round_robin" (
    "id" UUID NOT NULL,
    "last_assigned_manager_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manager_assignment_round_robin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesperson_assignment_round_robin" (
    "id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "last_assigned_salesperson_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesperson_assignment_round_robin_pkey" PRIMARY KEY ("id")
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
    "external_source" "external_source",
    "external_id" VARCHAR(100),
    "external_updated_at" TIMESTAMP(3),
    "external_number" VARCHAR(100),
    "shipping_address" JSONB,
    "shipping_pincode" VARCHAR(12),
    "cancel_reason" TEXT,
    "metadata" JSONB,
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
    "refunded_amount" DECIMAL(12,2),
    "external_source" "external_source",
    "external_id" VARCHAR(100),
    "payment_url" TEXT,
    "payment_expires_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "shipment_status" NOT NULL,
    "courier" VARCHAR(150),
    "tracking_number" VARCHAR(150),
    "tracking_url" TEXT,
    "shipped_at" TIMESTAMP(3),
    "expected_delivery_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "external_source" "external_source",
    "external_id" VARCHAR(100),
    "provider_order_id" VARCHAR(100),
    "channel_order_id" VARCHAR(100),
    "courier_company_id" INTEGER,
    "label_url" TEXT,
    "pickup_scheduled_at" TIMESTAMP(3),
    "provider_status" VARCHAR(150),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "code" VARCHAR(100),
    "description" TEXT,
    "type" "source_type" NOT NULL DEFAULT 'MANUAL',
    "status" "source_status" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB,
    "credentials" JSONB,
    "external_account_id" VARCHAR(255),
    "last_synced_at" TIMESTAMP(3),
    "last_sync_status" VARCHAR(50),
    "last_sync_error" TEXT,
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
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "source_id" UUID,
    "received_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "provider" "whatsapp_provider_name" NOT NULL,
    "provider_message_id" VARCHAR(255),
    "direction" "whatsapp_direction" NOT NULL,
    "message_type" "whatsapp_message_type" NOT NULL DEFAULT 'TEXT',
    "status" "whatsapp_message_status" NOT NULL,
    "lead_id" UUID,
    "from_number" VARCHAR(32),
    "to_number" VARCHAR(32),
    "normalized_contact" VARCHAR(20),
    "template_name" VARCHAR(150),
    "template_id" UUID,
    "order_id" UUID,
    "body" TEXT,
    "error_code" VARCHAR(100),
    "error_message" TEXT,
    "sent_by_id" UUID,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "provider" "whatsapp_provider_name" NOT NULL,
    "provider_template_id" VARCHAR(255),
    "external_id" VARCHAR(255),
    "category" VARCHAR(50),
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "status" "whatsapp_template_status" NOT NULL DEFAULT 'DRAFT',
    "quality" VARCHAR(50),
    "last_synced_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_automation_configs" (
    "id" UUID NOT NULL,
    "automation_type" "whatsapp_automation_type" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "template_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_automation_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_automation_runs" (
    "id" UUID NOT NULL,
    "automation_type" "whatsapp_automation_type" NOT NULL,
    "event_key" TEXT NOT NULL,
    "lead_id" UUID,
    "order_id" UUID,
    "status" "whatsapp_automation_run_status" NOT NULL,
    "whatsapp_message_id" UUID,
    "reason" TEXT,
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_campaigns" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "status" "whatsapp_campaign_status" NOT NULL DEFAULT 'DRAFT',
    "template_id" UUID NOT NULL,
    "filters" JSONB NOT NULL,
    "created_by_id" UUID,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_campaign_recipients" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "order_id" UUID,
    "status" "whatsapp_campaign_recipient_status" NOT NULL DEFAULT 'PENDING',
    "whatsapp_message_id" UUID,
    "failure_reason" TEXT,
    "attempted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_configs" (
    "id" UUID NOT NULL,
    "phone_number_id" VARCHAR(64) NOT NULL,
    "business_account_id" VARCHAR(64) NOT NULL,
    "display_phone_number" VARCHAR(32),
    "business_name" VARCHAR(150),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "credentials" JSONB NOT NULL,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_conversations" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "provider" "whatsapp_provider_name" NOT NULL,
    "mode" "conversation_mode" NOT NULL DEFAULT 'HUMAN',
    "assigned_to_id" UUID,
    "last_read_at" TIMESTAMP(3),
    "order_state" "order_conversation_state" NOT NULL DEFAULT 'DISCOVERY',
    "order_draft" JSONB,
    "ai_suggested_reply" TEXT,
    "last_ai_handoff_reason" TEXT,
    "created_order_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "activities_order_id_idx" ON "activities"("order_id");

-- CreateIndex
CREATE INDEX "activities_type_idx" ON "activities"("type");

-- CreateIndex
CREATE INDEX "activities_source_idx" ON "activities"("source");

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
CREATE UNIQUE INDEX "products_external_source_external_id_key" ON "products"("external_source", "external_id");

-- CreateIndex
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex
CREATE INDEX "product_variants_status_idx" ON "product_variants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_external_source_external_id_key" ON "product_variants"("external_source", "external_id");

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
CREATE INDEX "leads_assigned_manager_id_idx" ON "leads"("assigned_manager_id");

-- CreateIndex
CREATE INDEX "leads_import_batch_id_idx" ON "leads"("import_batch_id");

-- CreateIndex
CREATE INDEX "leads_working_status_idx" ON "leads"("working_status");

-- CreateIndex
CREATE INDEX "leads_priority_idx" ON "leads"("priority");

-- CreateIndex
CREATE INDEX "leads_created_at_idx" ON "leads"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_external_source_external_id_key" ON "leads"("external_source", "external_id");

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
CREATE INDEX "lead_import_batches_uploaded_by_id_idx" ON "lead_import_batches"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "lead_import_batches_status_idx" ON "lead_import_batches"("status");

-- CreateIndex
CREATE INDEX "lead_import_batches_created_at_idx" ON "lead_import_batches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "salesperson_assignment_round_robin_manager_id_key" ON "salesperson_assignment_round_robin"("manager_id");

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
CREATE INDEX "orders_shipping_pincode_idx" ON "orders"("shipping_pincode");

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_source_external_id_key" ON "orders"("external_source", "external_id");

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
CREATE UNIQUE INDEX "payments_external_source_external_id_key" ON "payments"("external_source", "external_id");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- CreateIndex
CREATE INDEX "shipments_tracking_number_idx" ON "shipments"("tracking_number");

-- CreateIndex
CREATE INDEX "shipments_provider_order_id_idx" ON "shipments"("provider_order_id");

-- CreateIndex
CREATE INDEX "shipments_channel_order_id_idx" ON "shipments"("channel_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_external_source_external_id_key" ON "shipments"("external_source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "sources_code_key" ON "sources"("code");

-- CreateIndex
CREATE INDEX "sources_type_idx" ON "sources"("type");

-- CreateIndex
CREATE INDEX "sources_external_account_id_idx" ON "sources"("external_account_id");

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
CREATE INDEX "webhook_events_status_next_attempt_at_idx" ON "webhook_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE INDEX "webhook_events_source_id_idx" ON "webhook_events"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_external_event_id_key" ON "webhook_events"("provider", "external_event_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_lead_id_idx" ON "whatsapp_messages"("lead_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_direction_idx" ON "whatsapp_messages"("direction");

-- CreateIndex
CREATE INDEX "whatsapp_messages_status_idx" ON "whatsapp_messages"("status");

-- CreateIndex
CREATE INDEX "whatsapp_messages_normalized_contact_idx" ON "whatsapp_messages"("normalized_contact");

-- CreateIndex
CREATE INDEX "whatsapp_messages_created_at_idx" ON "whatsapp_messages"("created_at");

-- CreateIndex
CREATE INDEX "whatsapp_messages_template_id_idx" ON "whatsapp_messages"("template_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_order_id_idx" ON "whatsapp_messages"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_provider_message_id_key" ON "whatsapp_messages"("provider", "provider_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_templates_status_idx" ON "whatsapp_templates"("status");

-- CreateIndex
CREATE INDEX "whatsapp_templates_category_idx" ON "whatsapp_templates"("category");

-- CreateIndex
CREATE INDEX "whatsapp_templates_language_idx" ON "whatsapp_templates"("language");

-- CreateIndex
CREATE INDEX "whatsapp_templates_provider_idx" ON "whatsapp_templates"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_provider_name_language_key" ON "whatsapp_templates"("provider", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_provider_provider_template_id_key" ON "whatsapp_templates"("provider", "provider_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_automation_configs_automation_type_key" ON "whatsapp_automation_configs"("automation_type");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_automation_runs_event_key_key" ON "whatsapp_automation_runs"("event_key");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_automation_type_idx" ON "whatsapp_automation_runs"("automation_type");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_lead_id_idx" ON "whatsapp_automation_runs"("lead_id");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_order_id_idx" ON "whatsapp_automation_runs"("order_id");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_status_idx" ON "whatsapp_automation_runs"("status");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_status_idx" ON "whatsapp_campaigns"("status");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_created_by_id_idx" ON "whatsapp_campaigns"("created_by_id");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_scheduled_at_idx" ON "whatsapp_campaigns"("scheduled_at");

-- CreateIndex
CREATE INDEX "whatsapp_campaign_recipients_campaign_id_status_idx" ON "whatsapp_campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "whatsapp_campaign_recipients_lead_id_idx" ON "whatsapp_campaign_recipients"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_campaign_recipients_campaign_id_lead_id_key" ON "whatsapp_campaign_recipients"("campaign_id", "lead_id");

-- CreateIndex
CREATE INDEX "whatsapp_configs_is_active_idx" ON "whatsapp_configs"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversations_lead_id_key" ON "whatsapp_conversations"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversations_created_order_id_key" ON "whatsapp_conversations"("created_order_id");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_assigned_to_id_idx" ON "whatsapp_conversations"("assigned_to_id");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_mode_idx" ON "whatsapp_conversations"("mode");

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
ALTER TABLE "activities" ADD CONSTRAINT "activities_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_manager_id_fkey" FOREIGN KEY ("assigned_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "lead_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_assignment_round_robin" ADD CONSTRAINT "manager_assignment_round_robin_last_assigned_manager_id_fkey" FOREIGN KEY ("last_assigned_manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesperson_assignment_round_robin" ADD CONSTRAINT "salesperson_assignment_round_robin_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesperson_assignment_round_robin" ADD CONSTRAINT "salesperson_assignment_round_robin_last_assigned_salespers_fkey" FOREIGN KEY ("last_assigned_salesperson_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_configs" ADD CONSTRAINT "whatsapp_automation_configs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_configs" ADD CONSTRAINT "whatsapp_automation_configs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_runs" ADD CONSTRAINT "whatsapp_automation_runs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_runs" ADD CONSTRAINT "whatsapp_automation_runs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_automation_runs" ADD CONSTRAINT "whatsapp_automation_runs_whatsapp_message_id_fkey" FOREIGN KEY ("whatsapp_message_id") REFERENCES "whatsapp_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaigns" ADD CONSTRAINT "whatsapp_campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaigns" ADD CONSTRAINT "whatsapp_campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "whatsapp_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_campaign_recipients" ADD CONSTRAINT "whatsapp_campaign_recipients_whatsapp_message_id_fkey" FOREIGN KEY ("whatsapp_message_id") REFERENCES "whatsapp_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_configs" ADD CONSTRAINT "whatsapp_configs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_configs" ADD CONSTRAINT "whatsapp_configs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_created_order_id_fkey" FOREIGN KEY ("created_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
