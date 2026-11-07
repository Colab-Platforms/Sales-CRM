-- Forward-only, additive: two new tables, nothing existing is changed. The pool is OFF until an Admin runs the approved `abandoned-pool configure --apply` step (no state row = disabled).
-- APPLY THIS BEFORE deploying the code that reads it.
CREATE TABLE "abandoned_pool_member" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "abandoned_pool_member_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "abandoned_pool_member_user_id_key" ON "abandoned_pool_member"("user_id");

CREATE TABLE "abandoned_pool_state" (
  "id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "enabled_at" TIMESTAMP(3),
  "last_assigned_user_id" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "abandoned_pool_state_pkey" PRIMARY KEY ("id")
);
