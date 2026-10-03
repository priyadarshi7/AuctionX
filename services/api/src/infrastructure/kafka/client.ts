import { Kafka, logLevel } from 'kafkajs';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// One Kafka client for the whole process — kafkajs's own docs recommend
// this (it's a lightweight config holder, not a connection itself;
// producers/consumers created from it manage their own connections).
// clientId identifies this process's connections in Redpanda/Kafka's own
// logs and metrics, distinguishing this API instance from, say, a future
// separate consumer-only deployment.
// SASL_SSL config for a managed broker (Aiven — ADR-0036). Local Redpanda
// has no auth at all, so this stays entirely absent (kafkajs defaults to
// plaintext) unless KAFKA_SASL_USERNAME is set — env.ts's superRefine
// already guarantees the other two are present whenever that one is.
const saslConfig =
  env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD && env.KAFKA_SSL_CA
    ? {
        ssl: {
          // Real newlines, not the literal "\n" the env var carries them as
          // (see env.ts's KAFKA_SSL_CA comment for why) — kafkajs hands this
          // straight to Node's tls module, which needs an actual PEM.
          ca: [env.KAFKA_SSL_CA.replace(/\\n/g, '\n')],
        },
        sasl: {
          // Aiven's own recommended mechanism for Node.js clients (PLAIN and
          // SCRAM-SHA-512 are also enabled broker-side, but SCRAM-SHA-256
          // never sends the password itself over the wire, only a proof
          // derived from it — meaningfully stronger than PLAIN for the same
          // TLS-wrapped connection).
          mechanism: 'scram-sha-256' as const,
          username: env.KAFKA_SASL_USERNAME,
          password: env.KAFKA_SASL_PASSWORD,
        },
      }
    : {};

export const kafka = new Kafka({
  clientId: 'auctionx-api',
  brokers: env.KAFKA_BROKERS.split(',').map((broker) => broker.trim()),
  ...saslConfig,
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
