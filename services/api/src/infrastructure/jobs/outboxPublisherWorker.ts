import { logger } from '../observability/logger';
import { isProducerConnected, producer } from '../kafka/producer';
import { claimOutboxEvents, markOutboxEventPublished, releaseOutboxEventClaim } from '../outbox/repository';

// How often the worker scans for unpublished events. Short enough that a
// notification feels close to real-time; not so short that it's polling
// meaningfully faster than Redpanda/Kafka round-trips take at this scale.
// Same order of magnitude as auctionClosingWorker's own SCAN_INTERVAL_MS,
// for the same reason: this isn't a hot path (Section 62), so there's no
// measured justification for anything tighter yet.
const SCAN_INTERVAL_MS = 2_000;
const BATCH_SIZE = 50;
// How long a claim is honored before another worker may reclaim the row —
// see claimOutboxEvents's doc comment. Comfortably longer than a batch of
// 50 sequential Kafka sends should ever take under normal conditions
// (Section 62 — no measured reason for anything tighter), short enough
// that a genuinely crashed worker's stuck rows recover promptly.
const CLAIM_LEASE_MS = 30_000;

let intervalHandle: NodeJS.Timeout | undefined;

// Exported and called directly by tests (same pattern as
// auctionClosingWorker's runOnce) — not just driven by the interval, so a
// test can publish deterministically without waiting on a timer.
export async function runOnce(): Promise<void> {
  if (!isProducerConnected()) {
    // Not an error — Section 40: Kafka/Redpanda being unreachable must not
    // block business transactions, and the Outbox table is exactly what
    // makes that safe. These events stay unpublished and get picked up the
    // next tick after the producer (re)connects, with no data loss.
    return;
  }

  // Claims (not just reads) this batch first — see claimOutboxEvents's doc
  // comment for why: without this, a second concurrent worker instance
  // (against the same Postgres) could select and publish the SAME rows,
  // producing duplicate Kafka messages for one logical event.
  const events = await claimOutboxEvents(BATCH_SIZE, CLAIM_LEASE_MS);

  for (const event of events) {
    try {
      // Sequential, not batched/parallel — preserves publish ORDER across
      // events (including across different topics, which a parallel send
      // could reorder), and this isn't a hot path (Section 62).
      await producer.send({
        topic: event.topic,
        messages: [{ key: event.key, value: JSON.stringify(event.payload) }],
      });
      await markOutboxEventPublished(event.id);
    } catch (err) {
      // One event failing to publish must not stop the rest of the batch
      // from being attempted, and must not mark THIS one published — it
      // stays unpublished (Section 41: this is a transient-failure retry,
      // not a poison-message concern — that's the consumer side's job, via
      // its own DLQ). Its claim is released immediately, not left to
      // expire — this worker is right here and available to retry it on
      // the very next scan, exactly like before this fix, rather than
      // waiting out the full crash-recovery lease for no reason.
      logger.error({ err, outboxEventId: event.id, topic: event.topic }, 'Failed to publish outbox event');
      await releaseOutboxEventClaim(event.id).catch((releaseErr: unknown) => {
        logger.error({ err: releaseErr, outboxEventId: event.id }, 'Failed to release outbox event claim');
      });
    }
  }
}

export function startOutboxPublisherWorker(): void {
  if (intervalHandle) {
    return;
  }
  intervalHandle = setInterval(() => {
    void runOnce().catch((err: unknown) => {
      logger.error({ err }, 'Outbox publisher worker scan failed');
    });
  }, SCAN_INTERVAL_MS);
}

export function stopOutboxPublisherWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
