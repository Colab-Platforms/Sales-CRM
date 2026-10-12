-- CreateTable
CREATE TABLE "manager_auto_assign_targets" (
    "id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_auto_assign_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manager_auto_assign_targets_manager_id_key" ON "manager_auto_assign_targets"("manager_id");

-- AddForeignKey
ALTER TABLE "manager_auto_assign_targets" ADD CONSTRAINT "manager_auto_assign_targets_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
