CREATE TABLE "break_limit_config" (
    "id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "max_concurrent_breaks" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "break_limit_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "break_limit_config_manager_id_key" ON "break_limit_config"("manager_id");

ALTER TABLE "break_limit_config" ADD CONSTRAINT "break_limit_config_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
