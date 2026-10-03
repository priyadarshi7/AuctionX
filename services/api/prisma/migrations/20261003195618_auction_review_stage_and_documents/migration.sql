-- AlterEnum
ALTER TYPE "AuctionStatus" ADD VALUE 'PENDING_REVIEW';

-- AlterTable
ALTER TABLE "auctions" ADD COLUMN     "requestedDurationSeconds" INTEGER,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "trustedSeller" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "auction_documents" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auction_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auction_documents_objectKey_key" ON "auction_documents"("objectKey");

-- CreateIndex
CREATE INDEX "auction_documents_auctionId_idx" ON "auction_documents"("auctionId");

-- AddForeignKey
ALTER TABLE "auction_documents" ADD CONSTRAINT "auction_documents_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "auctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
