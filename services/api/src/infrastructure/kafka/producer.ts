import { kafka } from './client';
import { logger } from '../observability/logger';

// kafkajs v2 warns loudly about a default-partitioner behavior change
// unless this is set. Silenced deliberately, not just suppressed blindly:
// every topic this project uses (docker-compose.yml's redpanda service)
// has exactly one partition at this scale, so which partitioner strategy
// is used has no observable effect yet — this becomes a real decision to
// revisit only once a topic is actually multi-partitioned.
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

// idempotent: true — a producer-level retry (e.g. a network blip between
// this process and Redpanda right as a send() was in flight) cannot
// duplicate the message on the broker side. This is NOT the same
// correctness property as the Outbox pattern itself (which prevents
// publishing an event for a transaction that never committed, or losing
// one for a transaction that did) — the two are complementary, not
// redundant: idempotent producing covers the network hop, the Outbox
// covers the "did this event happen at all" question. Section 15 is
// explicit not to casually claim "exactly once" — this gets you
// effectively-once delivery to the topic, not exactly-once processing by
// a consumer (that's the consumer's own idempotency job — see
// modules/notifications/consumer.ts).
export const producer = kafka.producer({ idempotent: true });

let connected = false;

// Fire-and-forget from server.ts, same pattern as ensureBucketExists
// (MEDIA-001) — never blocks the server from accepting traffic, and never
// throws. kafkajs's own connect() already retries internally with backoff
// (its default retry config), so a Redpanda that isn't up yet at boot
// resolves itself without this needing to loop manually.
export async function connectProducer(): Promise<void> {
  try {
    await producer.connect();
    connected = true;
    logger.info('Kafka producer connected');
  } catch (err) {
    logger.error({ err }, 'Kafka producer failed to connect');
  }
}

export function isProducerConnected(): boolean {
  return connected;
}

export async function disconnectProducer(): Promise<void> {
  if (!connected) {
    return;
  }
  await producer.disconnect();
  connected = false;
}
