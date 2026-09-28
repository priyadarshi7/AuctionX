-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

-- AlterTable: added nullable first (existing rows predate the Outbox
-- pattern and have no real originating OutboxEvent), backfilled, then
-- tightened to NOT NULL — a plain `ADD COLUMN ... NOT NULL` with no
-- default fails outright against a non-empty table (verified: this
-- database has 3 real notification rows from real usage, not just test
-- data, so a destructive "add and truncate" shortcut was never an option).
ALTER TABLE "notifications" ADD COLUMN     "sourceEventId" TEXT;

-- Backfill: each pre-existing row's own id becomes its sourceEventId — an
-- honest placeholder ("this notification predates the outbox pattern"),
-- and trivially satisfies the uniqueness constraint added below since a
-- row's own id is already unique.
UPDATE "notifications" SET "sourceEventId" = "id" WHERE "sourceEventId" IS NULL;

ALTER TABLE "notifications" ALTER COLUMN "sourceEventId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_sourceEventId_userId_key" ON "notifications"("sourceEventId", "userId");
