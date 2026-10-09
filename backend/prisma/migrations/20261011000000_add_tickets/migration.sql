-- CreateEnum
CREATE TYPE "ticket_category" AS ENUM ('LEAD_ISSUE', 'ORDER_PAYMENT', 'WHATSAPP_CALLING', 'LOGIN_ACCESS', 'TECHNICAL_BUG', 'OTHER');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "ticket_number" SERIAL NOT NULL,
    "raised_by_id" UUID NOT NULL,
    "category" "ticket_category" NOT NULL,
    "priority" "ticket_priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "ticket_status" NOT NULL DEFAULT 'OPEN',
    "subject" VARCHAR(200) NOT NULL,
    "description" VARCHAR(5000) NOT NULL,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_ticket_number_key" ON "tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "tickets_raised_by_id_created_at_idx" ON "tickets"("raised_by_id", "created_at");

-- CreateIndex
CREATE INDEX "tickets_status_created_at_idx" ON "tickets"("status", "created_at");

-- CreateIndex
CREATE INDEX "ticket_comments_ticket_id_created_at_idx" ON "ticket_comments"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raised_by_id_fkey" FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
