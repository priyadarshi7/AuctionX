-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "refundRef" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);
