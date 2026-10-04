-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('OTP', 'AUTO');

-- CreateEnum
CREATE TYPE "ShipmentEventType" AS ENUM ('LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveredVia" "DeliveryMethod",
ADD COLUMN     "deliveryOtpAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryOtpVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "shippingAddress" JSONB;

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "ShipmentEventType" NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_events_orderId_occurredAt_idx" ON "shipment_events"("orderId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_orderId_type_key" ON "shipment_events"("orderId", "type");

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
