-- CreateEnum
CREATE TYPE "OrderCancelReason" AS ENUM ('PAYMENT_TIMEOUT', 'ADMIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ORDER_SHIPPED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_DELIVERED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'SHIPPED';
ALTER TYPE "OrderStatus" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancelReason" "OrderCancelReason",
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "paymentDueAt" TIMESTAMP(3),
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "trackingNumber" TEXT;

-- CreateIndex
CREATE INDEX "orders_status_paymentDueAt_idx" ON "orders"("status", "paymentDueAt");

-- Backfill: orders created before this migration have no payment deadline.
-- Give every still-unpaid one a FRESH 48h window from now, rather than
-- deriving it from createdAt, so deploying this migration can't make the new
-- payment-deadline worker instantly cancel orders that are already overdue
-- by the new rule. (Enum values added above are intentionally not used here:
-- a value added by ALTER TYPE can't be used in the same transaction.)
UPDATE "orders" SET "paymentDueAt" = now() + interval '48 hours' WHERE "status" = 'PENDING_PAYMENT';
