-- CreateTable
CREATE TABLE "salesperson_assignment_round_robin" (
    "id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "last_assigned_salesperson_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesperson_assignment_round_robin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salesperson_assignment_round_robin_manager_id_key" ON "salesperson_assignment_round_robin"("manager_id");

-- AddForeignKey
ALTER TABLE "salesperson_assignment_round_robin" ADD CONSTRAINT "salesperson_assignment_round_robin_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesperson_assignment_round_robin" ADD CONSTRAINT "salesperson_assignment_round_robin_last_assigned_salespers_fkey" FOREIGN KEY ("last_assigned_salesperson_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
