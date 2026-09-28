import { Kafka, logLevel } from 'kafkajs';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// One Kafka client for the whole process — kafkajs's own docs recommend
// this (it's a lightweight config holder, not a connection itself;
// producers/consumers created from it manage their own connections).
// clientId identifies this process's connections in Redpanda/Kafka's own
// logs and metrics, distinguishing this API instance from, say, a future
// separate consumer-only deployment.
export const kafka = new Kafka({
  clientId: 'auctionx-api',
  brokers: env.KAFKA_BROKERS.split(',').map((broker) => broker.trim()),
  // Routes kafkajs's internal logs through this app's own structured
  // logger (Section 34) instead of kafkajs's default console output, and
  // caps it at WARN — INFO-level here is mostly connection-lifecycle noise
  // that would drown out this app's own request logs.
  logLevel: logLevel.WARN,
  logCreator:
    () =>
    ({ level, log }) => {
      const { message, ...extra } = log;
      if (level === logLevel.ERROR || level === logLevel.NOTHING) {
        logger.error(extra, message);
      } else if (level === logLevel.WARN) {
        logger.warn(extra, message);
      } else {
        logger.info(extra, message);
      }
    },
});
