-- Who confirmed the order in the CRM (current confirmer). Additive and nullable: existing orders are untouched.
ALTER TABLE "orders" ADD COLUMN "confirmed_by_user_id" UUID;
ALTER TABLE "orders" ADD COLUMN "confirmed_by_name" VARCHAR(150);

ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "orders_confirmed_by_user_id_idx" ON "orders"("confirmed_by_user_id");
