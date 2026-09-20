-- AlterTable
ALTER TABLE "whatsapp_messages" ADD COLUMN     "order_id" UUID,
ADD COLUMN     "template_id" UUID;

-- CreateIndex
CREATE INDEX "whatsapp_messages_template_id_idx" ON "whatsapp_messages"("template_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_order_id_idx" ON "whatsapp_messages"("order_id");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

