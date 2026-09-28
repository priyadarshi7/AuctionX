import { Client } from '@opensearch-project/opensearch';
import { env } from '../../config/env';

// A plain singleton, same shape as infrastructure/kafka/client.ts and
// infrastructure/storage/s3Client.ts — no connection pool to manage
// ourselves, the client library handles that. Search is never load-bearing
// for anything else booting (Section 25/40): nothing here throws at import
// time if OpenSearch happens to be unreachable, exactly like Redis/Kafka.
export const searchClient = new Client({ node: env.OPENSEARCH_URL });
