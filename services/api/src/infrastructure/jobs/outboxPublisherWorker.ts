import { logger } from '../observability/logger';
import { isProducerConnected, producer } from '../kafka/producer';
import { findUnpublishedOutboxEvents, markOutboxEventPublished } from '../outbox/repository';

// How often the worker scans for unpublished events. Short enough that a
// notification feels close to real-time; not so short that it's polling
// meaningfully faster than Redpanda/Kafka round-trips take at this scale.
// Same order of magnitude as auctionClosingWorker's own SCAN_INTERVAL_MS,
// for the same reason: this isn't a hot path (Section 62), so there's no
// measured justification for anything tighter yet.
const SCAN_INTERVAL_MS = 2_000;
const BATCH_SIZE = 50;

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

  const events = await findUnpublishedOutboxEvents(BATCH_SIZE);

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
      // stays unpublished and is retried next tick (Section 41: this is a
      // transient-failure retry, not a poison-message concern — that's the
      // consumer side's job, via its own DLQ).
      logger.error({ err, outboxEventId: event.id, topic: event.topic }, 'Failed to publish outbox event');
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
