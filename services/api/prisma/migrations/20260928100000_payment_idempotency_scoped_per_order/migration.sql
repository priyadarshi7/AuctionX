-- DropIndex
DROP INDEX "payments_idempotencyKey_key";

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "providerRef" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_idempotencyKey_key" ON "payments"("orderId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_providerRef_key" ON "payments"("provider", "providerRef");

