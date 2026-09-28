-- CreateEnum
CREATE TYPE "ValuationStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "auction_valuations" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "status" "ValuationStatus" NOT NULL DEFAULT 'PENDING',
    "estimatedValueCents" INTEGER,
    "priceRangeLowCents" INTEGER,
    "priceRangeHighCents" INTEGER,
    "confidence" DOUBLE PRECISION,
    "explanation" TEXT,
    "model" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auction_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auction_valuations_auctionId_key" ON "auction_valuations"("auctionId");

-- AddForeignKey
ALTER TABLE "auction_valuations" ADD CONSTRAINT "auction_valuations_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "auctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
