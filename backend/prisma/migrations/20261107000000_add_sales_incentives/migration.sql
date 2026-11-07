-- CreateTable
CREATE TABLE "incentive_policy" (
    "id" UUID NOT NULL,
    "slabs" JSONB NOT NULL,
    "percent_basis" VARCHAR(20),
    "min_prepaid_percent" INTEGER NOT NULL DEFAULT 40,
    "min_delivery_percent" INTEGER NOT NULL DEFAULT 80,
    "min_attendance_days" INTEGER NOT NULL DEFAULT 26,
    "min_net_login_minutes" INTEGER NOT NULL DEFAULT 480,
    "min_login_days" INTEGER NOT NULL DEFAULT 26,
    "min_daily_calls" INTEGER NOT NULL DEFAULT 100,
    "min_call_days" INTEGER NOT NULL DEFAULT 26,
    "min_avg_daily_orders_x100" INTEGER NOT NULL DEFAULT 1200,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incentive_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_months" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "paid_by_id" UUID,
    "paid_at" TIMESTAMP(3),
    "payment_ref" VARCHAR(120),
    "payment_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incentive_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_queries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "message" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "response" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "user_id" UUID,
    "month" VARCHAR(7),
    "action" VARCHAR(40) NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incentive_months_month_idx" ON "incentive_months"("month");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_months_user_id_month_key" ON "incentive_months"("user_id", "month");

-- CreateIndex
CREATE INDEX "incentive_queries_user_id_month_idx" ON "incentive_queries"("user_id", "month");

-- CreateIndex
CREATE INDEX "incentive_queries_status_idx" ON "incentive_queries"("status");

-- CreateIndex
CREATE INDEX "incentive_audit_logs_created_at_idx" ON "incentive_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "incentive_audit_logs_user_id_month_idx" ON "incentive_audit_logs"("user_id", "month");

-- AddForeignKey
ALTER TABLE "incentive_months" ADD CONSTRAINT "incentive_months_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incentive_queries" ADD CONSTRAINT "incentive_queries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

