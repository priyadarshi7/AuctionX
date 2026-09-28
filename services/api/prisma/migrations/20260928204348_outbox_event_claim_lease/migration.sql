-- Nullable, no backfill needed: outbox_events is ephemeral/derived data
-- (the model's own doc comment) and every existing row is either already
-- published (irrelevant to claiming) or genuinely unclaimed (NULL is the
-- correct starting state for it too).
ALTER TABLE "outbox_events" ADD COLUMN "claimedAt" TIMESTAMP(3);

DROP INDEX "outbox_events_publishedAt_createdAt_idx";
CREATE INDEX "outbox_events_publishedAt_claimedAt_createdAt_idx" ON "outbox_events"("publishedAt", "claimedAt", "createdAt");
