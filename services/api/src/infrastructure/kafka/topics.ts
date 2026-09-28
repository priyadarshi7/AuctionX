import { env } from '../../config/env';

// A distinct topic in tests, not just a distinct consumer group id
// (modules/search/consumer.ts's GROUP_ID, same pattern as modules/
// notifications/consumer.ts). Kafka topics aren't environment-scoped —
// without this, a live `npm run dev` server (a separate, already-running
// process, independently subscribed to 'search-events' in its OWN
// consumer group) still receives its own full copy of every message a
// test run publishes, and indexes it into the REAL OpenSearch index,
// regardless of which process created the auction. Consumer-group
// isolation alone only prevents two processes in the SAME group from
// fighting over partitions — it does nothing to stop a DIFFERENT group
// from independently consuming the same shared topic. Found the hard way:
// even after giving the search index itself a `-test` suffix
// (modules/search/repository.ts), a live dev server left running during a
// test run still polluted the real index, because it was reading the
// SAME topic the test just published to.
export const SEARCH_EVENTS_TOPIC = env.NODE_ENV === 'test' ? 'search-events-test' : 'search-events';
