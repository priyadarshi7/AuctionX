import type { Consumer } from 'kafkajs';
import { kafka } from './client';
import { producer } from './producer';
import { logger } from '../observability/logger';

// (topic, partition, offset) is Kafka's own guaranteed-unique identifier
// for one specific message — a redelivery of the same message (Kafka is
// at-least-once, Section 15) always carries the SAME triple. Using this as
// the idempotency key (rather than asking every producer to invent and
// embed its own event id) means consumers get a correct dedup key for
// free, with no coordination needed between publisher and consumer code.
export type MessageId = string;

export type MessageHandler = (topic: string, key: string | null, payload: unknown, messageId: MessageId) => Promise<void>;

export function createConsumer(groupId: string): Consumer {
  return kafka.consumer({ groupId });
}

// Subscribes `consumer` to `topics` and runs `handler` for every message.
// fromBeginning: true — the first time a given consumer GROUP ID ever
// connects (no committed offsets yet), it replays the topic's full
// history rather than starting from "now." Without this, any outbox event
// published in the (usually brief, but real) window before this specific
// consumer group first came online would be silently skipped forever —
// unacceptable for a notification, which must still reach the user even
// if it was momentarily down. Once offsets exist for this group, this
// setting no longer matters.
//
// On a handler failure, the raw message is republished to `{topic}-dlq`
// (Section 15's dead-letter queue) and this consumer's offset still
// advances — Section 43: one poison message must not block its partition
// forever. The cost is that message's processing not being automatically
// retried past that point; it's still recoverable from the DLQ topic by
// whoever inspects it later, just not by this consumer.
export async function runConsumer(consumer: Consumer, topics: string[], handler: MessageHandler): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const messageId: MessageId = `${topic}:${partition}:${message.offset}`;
      const key = message.key?.toString('utf8') ?? null;

      let payload: unknown;
      try {
        payload = message.value ? JSON.parse(message.value.toString('utf8')) : null;
      } catch (err) {
        logger.error({ err, topic, messageId }, 'Kafka consumer: unparseable message, sending to DLQ');
        await sendToDlq(topic, message);
        return;
      }

      try {
        await handler(topic, key, payload, messageId);
      } catch (err) {
        logger.error({ err, topic, messageId }, 'Kafka consumer: handler failed, sending to DLQ');
        await sendToDlq(topic, message);
      }
    },
  });
}

async function sendToDlq(topic: string, message: { key: Buffer | null; value: Buffer | null }): Promise<void> {
  try {
    await producer.send({
      topic: `${topic}-dlq`,
      messages: [{ key: message.key ?? null, value: message.value ?? null }],
    });
  } catch (err) {
    // The DLQ publish itself failing (e.g. Redpanda genuinely unreachable)
    // is logged, not retried further here — the original message was
    // already durably on its source topic at its own (topic, partition,
    // offset), so nothing is lost, only the DLQ copy didn't get made this
    // time.
    logger.error({ err, topic }, 'Kafka consumer: failed to publish to DLQ topic itself');
  }
}
