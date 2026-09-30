-- CreateTable
CREATE TABLE "manager_auto_assign_config" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manager_auto_assign_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salesperson_auto_assign_config" (
    "id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesperson_auto_assign_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salesperson_auto_assign_config_manager_id_key" ON "salesperson_auto_assign_config"("manager_id");

-- AddForeignKey
ALTER TABLE "manager_auto_assign_config" ADD CONSTRAINT "manager_auto_assign_config_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesperson_auto_assign_config" ADD CONSTRAINT "salesperson_auto_assign_config_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
