-- CreateEnum
CREATE TYPE "AuctionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "AuctionCategory" AS ENUM ('ART', 'COLLECTIBLES', 'JEWELRY', 'WATCHES', 'COINS_AND_CURRENCY', 'MEMORABILIA', 'BOOKS_AND_MANUSCRIPTS', 'OTHER');

-- CreateEnum
CREATE TYPE "AuctionCondition" AS ENUM ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR');

-- CreateTable
CREATE TABLE "auctions" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "AuctionCategory" NOT NULL,
    "condition" "AuctionCondition" NOT NULL,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startingPriceCents" INTEGER NOT NULL,
    "reservePriceCents" INTEGER,
    "currentPriceCents" INTEGER NOT NULL,
    "status" "AuctionStatus" NOT NULL DEFAULT 'DRAFT',
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auctions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auctions_sellerId_idx" ON "auctions"("sellerId");

-- CreateIndex
CREATE INDEX "auctions_status_idx" ON "auctions"("status");

-- CreateIndex
CREATE INDEX "auctions_status_endTime_idx" ON "auctions"("status", "endTime");

-- AddForeignKey
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
