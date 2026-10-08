-- CreateEnum
CREATE TYPE "work_status" AS ENUM ('ACTIVE', 'ON_CALL', 'TEA_BREAK', 'LUNCH_BREAK', 'BIO_BREAK', 'TEAM_HUDDLE', 'IDLE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "session_end_reason" AS ENUM ('LOGOUT', 'STALE');

-- CreateTable
CREATE TABLE "work_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" "session_end_reason",
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_status" "work_status" NOT NULL DEFAULT 'ACTIVE',
    "status_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_logs" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "work_status" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_sessions_user_id_started_at_idx" ON "work_sessions"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "work_sessions_ended_at_idx" ON "work_sessions"("ended_at");

-- CreateIndex
CREATE INDEX "status_logs_session_id_idx" ON "status_logs"("session_id");

-- CreateIndex
CREATE INDEX "status_logs_user_id_started_at_idx" ON "status_logs"("user_id", "started_at");

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "work_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
